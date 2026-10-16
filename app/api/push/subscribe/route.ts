import { NextResponse } from 'next/server';
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { NO_ORG_MESSAGE } from '@/lib/settings/org-access';
import { parsePushSubscriptionBody } from '@/lib/notifications/push-targets';

// Register (or refresh) this browser's Web Push subscription. Only a signed-in
// MEMBER of an org can subscribe, and the row is stamped with that org + user
// (never taken from the body). The endpoint is the unique key, so a device
// re-subscribing UPDATEs its keys rather than creating a duplicate row.
//
// The same browser can be shared — user A enables notifications, user B later
// logs in on that device. The device must end up owned by whoever is signed in
// on it now (owner decision D19), but under RLS (user_id = auth.uid()) B can
// neither see nor update A's row, so a plain ON CONFLICT (endpoint) DO UPDATE
// would fail. The write therefore goes through the register_push_subscription
// RPC (migration 0065), called with the user's own session: it re-checks the
// membership of p_org, validates the input itself and takes user_id from
// auth.uid(), so the actor stays the signed-in user and no service-role key is
// involved. p_org is always the caller's own org from the context.

interface SubscribeBody {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    userAgent?: unknown;
}

export async function POST(request: Request) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);

    let payload: SubscribeBody;
    try {
        payload = (await request.json()) as SubscribeBody;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const sub = parsePushSubscriptionBody(payload);
    if (!sub) {
        return NextResponse.json({ error: 'Missing subscription fields' }, { status: 400 });
    }
    const userAgent =
        typeof payload.userAgent === 'string' ? payload.userAgent.slice(0, 400) : null;

    const { error } = await access.supabase.rpc('register_push_subscription', {
        p_org: access.orgId,
        p_endpoint: sub.endpoint,
        p_p256dh: sub.p256dh,
        p_auth: sub.auth,
        p_user_agent: userAgent,
    });
    if (error) {
        // 42501: the RPC found no membership for this user in the org (e.g.
        // removed since the context was resolved).
        if (error.code === '42501') {
            return NextResponse.json({ error: NO_ORG_MESSAGE }, { status: 403 });
        }
        // 22023: the RPC's own input checks refused an endpoint the URL parser
        // accepted (edge forms only; real endpoints are canonical).
        if (error.code === '22023') {
            return NextResponse.json({ error: 'Missing subscription fields' }, { status: 400 });
        }
        console.error('push subscribe failed', error);
        return NextResponse.json({ error: 'Gagal menyimpan langganan notifikasi' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
