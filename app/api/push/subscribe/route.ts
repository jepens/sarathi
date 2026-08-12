import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentOrgId } from '@/lib/settings/org-context';

// Register (or refresh) this browser's Web Push subscription. Auth-gated: only a
// signed-in dashboard user can subscribe. The endpoint is the unique key, so a
// device re-subscribing UPDATEs its keys rather than creating a duplicate row.

interface SubscribeBody {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    userAgent?: unknown;
}

export async function POST(request: Request) {
    const supabase = await createClient();
    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload: SubscribeBody;
    try {
        payload = (await request.json()) as SubscribeBody;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint : '';
    const p256dh = typeof payload.keys?.p256dh === 'string' ? payload.keys.p256dh : '';
    const auth = typeof payload.keys?.auth === 'string' ? payload.keys.auth : '';
    if (!endpoint || !p256dh || !auth) {
        return NextResponse.json({ error: 'Missing subscription fields' }, { status: 400 });
    }
    const userAgent =
        typeof payload.userAgent === 'string' ? payload.userAgent.slice(0, 400) : null;

    const { error } = await supabase.from('push_subscriptions').upsert(
        {
            org_id: orgId,
            endpoint,
            p256dh,
            auth,
            user_agent: userAgent,
            last_used_at: new Date().toISOString(),
        },
        { onConflict: 'endpoint' },
    );
    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
