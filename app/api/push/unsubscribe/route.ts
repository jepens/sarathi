import { NextResponse } from 'next/server';
import { accessDeniedResponse, requireUserContext } from '@/lib/settings/org-context';
import { createServiceOrServerClient } from '@/lib/supabase/service';

// Remove this browser's Web Push subscription. Session-gated
// (requireUserContext — verified JWT, no membership needed) and scoped to the
// CURRENT user: only their own row for this endpoint is deleted, so nobody can
// drop another user's device.
//
// The delete runs with the service-role client because the live RLS policy on
// push_subscriptions requires org membership — a user who has just lost their
// membership could otherwise never remove their device. The service-role
// query is therefore ALWAYS filtered by user_id = the verified user AND the
// endpoint; never by endpoint alone. (Without a service-role key — local dev —
// createServiceOrServerClient falls back to the RLS client, same filters.)
//
// Deleting by endpoint is naturally idempotent — a missing row is a no-op, so a
// double unsubscribe (or unsubscribing an already-pruned endpoint) still
// returns ok. Called on logout too, before signOut, while the session is valid.

interface UnsubscribeBody {
    endpoint?: unknown;
}

export async function POST(request: Request) {
    const access = await requireUserContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { userId } = access;

    let payload: UnsubscribeBody;
    try {
        payload = (await request.json()) as UnsubscribeBody;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint : '';
    if (!endpoint) {
        return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }

    const admin = await createServiceOrServerClient();
    const { error } = await admin
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint)
        .eq('user_id', userId);
    if (error) {
        console.error('push unsubscribe failed', error);
        return NextResponse.json({ error: 'Gagal menghapus langganan notifikasi' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
