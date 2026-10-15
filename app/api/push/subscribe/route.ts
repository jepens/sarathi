import { NextResponse } from 'next/server';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { parsePushSubscriptionBody } from '@/lib/notifications/push-targets';

// Register (or refresh) this browser's Web Push subscription. Only a signed-in
// MEMBER of an org can subscribe, and the row is stamped server-side with that
// org + user (never taken from the body). The endpoint is the unique key, so a
// device re-subscribing UPDATEs its keys rather than creating a duplicate row.
//
// Why the write uses the service-role client (after the checks above): the same
// browser can be shared — user A enables notifications, user B later logs in on
// that device. The push endpoint row still belongs to A, and under RLS
// (user_id = auth.uid()) B can neither see nor update it, so B's
// ON CONFLICT (endpoint) DO UPDATE would fail. The device must end up owned by
// whoever is signed in on it now. That is safe because the caller has been
// authenticated and their membership verified here, org_id/user_id come from
// the server, and holding the endpoint + keys proves control of that browser's
// subscription. Without a service-role key this falls back to the user client:
// fresh and own-device subscriptions still work; only the reassignment fails.

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

    const writer = await createServiceOrServerClient();
    const { error } = await writer.from('push_subscriptions').upsert(
        {
            org_id: access.orgId,
            user_id: access.userId,
            endpoint: sub.endpoint,
            p256dh: sub.p256dh,
            auth: sub.auth,
            user_agent: userAgent,
            last_used_at: new Date().toISOString(),
        },
        { onConflict: 'endpoint' },
    );
    if (error) {
        console.error('push subscribe failed', error);
        return NextResponse.json({ error: 'Gagal menyimpan langganan notifikasi' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
