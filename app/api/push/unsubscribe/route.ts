import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Remove this browser's Web Push subscription. Auth-gated and scoped to the
// CURRENT user: only their own row for this endpoint is deleted (RLS enforces
// the same), so nobody can drop another user's device. Deleting by endpoint is
// naturally idempotent — a missing row is a no-op, so a double unsubscribe (or
// unsubscribing an already-pruned endpoint) still returns ok. Called on logout
// too, before signOut, while the session is still valid.

interface UnsubscribeBody {
    endpoint?: unknown;
}

export async function POST(request: Request) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint)
        .eq('user_id', user.id);
    if (error) {
        console.error('push unsubscribe failed', error);
        return NextResponse.json({ error: 'Gagal menghapus langganan notifikasi' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
