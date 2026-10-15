import 'server-only';
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { whatsappLogger } from '@/lib/utils/logger';
import {
    filterSubscriptionsToMembers,
    isUndefinedColumn,
    type OwnedSubscriptionRow,
} from '@/lib/notifications/push-targets';

type SubscriptionKeys = Pick<OwnedSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>;

// Server-side Web Push fan-out (Tier 2 notifications).
//
// The webhook calls sendPushToOrg() after storing a genuinely new inbound
// message, so every subscribed admin device is alerted even with the dashboard
// closed. Configuration comes from three env vars (see .env.example):
//   VAPID_PUBLIC_KEY  / NEXT_PUBLIC_VAPID_PUBLIC_KEY  — the same public key
//   VAPID_PRIVATE_KEY — server-only signing key
//   VAPID_SUBJECT     — mailto: or https: contact, required by the spec
// When the keys are absent the helper is a no-op, so Tier 1 keeps working and the
// feature simply stays dormant until keys are configured.

export interface PushPayload {
    title: string;
    body: string;
    /** whatsapp_chats.phone_number — used for the notification tag + deep link. */
    phone: string;
    /** Where notificationclick should land (e.g. /dashboard/chats?phone=…). */
    url: string;
}

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@sailendra.co.id';

let vapidReady = false;
let vapidFailed = false;

/** True when both VAPID keys are configured — Tier 2 can send. */
export function isPushConfigured(): boolean {
    return Boolean(PUBLIC_KEY && PRIVATE_KEY);
}

// Set the VAPID details exactly once, lazily, so importing this module has no
// side effects when the keys are missing (and never throws at import time).
// setVapidDetails() validates and throws synchronously on malformed config (bad
// subject scheme, wrong key length, …). We catch that, log it ONCE, and memoize
// the failure so we never re-throw on every subsequent inbound message — keeping
// this helper's "never throws" contract for both unset AND misconfigured keys.
function ensureVapid(): boolean {
    if (vapidReady) return true;
    if (vapidFailed) return false;
    if (!isPushConfigured()) return false;
    try {
        webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
        vapidReady = true;
        return true;
    } catch (err) {
        vapidFailed = true;
        whatsappLogger.error(
            'Web push: invalid VAPID configuration — Tier 2 disabled until fixed',
            err,
        );
        return false;
    }
}

/**
 * Fan a Web Push notification out to every subscribed device in the org whose
 * owner is still a member of that org (a removed member's devices are skipped).
 * Best-effort and self-contained: never throws, prunes dead subscriptions
 * (HTTP 404/410 from the push service), and no-ops when push is not configured.
 *
 * Pass a SERVICE-ROLE Supabase client (the webhook already has one) — RLS would
 * otherwise hide the rows.
 */
export async function sendPushToOrg(
    supabase: SupabaseClient,
    orgId: string,
    payload: PushPayload,
): Promise<void> {
    if (!ensureVapid()) return;

    const { data, error } = await supabase
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth, user_id')
        .eq('org_id', orgId);

    let subs: SubscriptionKeys[];
    if (error && isUndefinedColumn(error)) {
        // Rollout window only: this code is live but migration 0058 (which adds
        // push_subscriptions.user_id) is not applied yet. Keep the pre-0058
        // behaviour — every row of the org — so the default org doesn't lose
        // push notifications meanwhile. Dead code once 0058 is applied; remove
        // it in Fase 1.
        whatsappLogger.warn('Web push: push_subscriptions.user_id missing (0058 not applied) — legacy fan-out');
        const legacy = await supabase
            .from('push_subscriptions')
            .select('endpoint, p256dh, auth')
            .eq('org_id', orgId);
        if (legacy.error) {
            whatsappLogger.error('Web push: failed to load subscriptions', legacy.error);
            return;
        }
        subs = (legacy.data ?? []) as SubscriptionKeys[];
    } else if (error) {
        whatsappLogger.error('Web push: failed to load subscriptions', error);
        return;
    } else {
        const rows = (data ?? []) as OwnedSubscriptionRow[];
        if (rows.length === 0) return;

        // Only devices owned by CURRENT members of the org receive its message
        // previews. Fail closed: if membership can't be read, send nothing.
        const { data: members, error: membersErr } = await supabase
            .from('organization_members')
            .select('user_id')
            .eq('org_id', orgId);
        if (membersErr) {
            whatsappLogger.error('Web push: failed to load org members', membersErr);
            return;
        }
        subs = filterSubscriptionsToMembers(
            rows,
            (members ?? []).map((m) => m.user_id as string),
        );
    }
    if (subs.length === 0) return;

    // Keep the payload small (push services cap at ~4KB) and safe to render.
    const body = JSON.stringify({
        title: payload.title.slice(0, 120),
        body: payload.body.slice(0, 240),
        phone: payload.phone,
        url: payload.url,
    });

    const stale: string[] = [];
    let sent = 0;
    await Promise.all(
        subs.map(async (sub) => {
            try {
                await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    body,
                );
                sent += 1;
            } catch (err) {
                const status = (err as { statusCode?: number }).statusCode;
                // 404 Not Found / 410 Gone → the browser dropped this subscription;
                // remove it so we stop pushing to a dead endpoint.
                if (status === 404 || status === 410) {
                    stale.push(sub.endpoint);
                } else {
                    whatsappLogger.error(`Web push send failed (status ${status ?? '?'})`, err);
                }
            }
        }),
    );

    // Observability: a single summary line per inbound so it's clear from the
    // server logs whether Tier 2 actually dispatched (sent N/M) vs. silently
    // no-op'd (this line absent → VAPID unset or org had no subscriptions).
    whatsappLogger.info(`Web push: sent ${sent}/${subs.length} notification(s) for org ${orgId}`);

    if (stale.length > 0) {
        const { error: pruneErr } = await supabase
            .from('push_subscriptions')
            .delete()
            .in('endpoint', stale);
        if (pruneErr) {
            whatsappLogger.error('Web push: failed to prune stale subscriptions', pruneErr);
        } else {
            whatsappLogger.info(`Web push: pruned ${stale.length} stale subscription(s)`);
        }
    }
}
