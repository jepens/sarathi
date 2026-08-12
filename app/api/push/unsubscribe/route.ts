import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentOrgId } from '@/lib/settings/org-context';

// Remove this browser's Web Push subscription. Auth-gated. Deleting by endpoint
// is naturally idempotent — a missing row is a no-op, so a double unsubscribe (or
// unsubscribing an already-pruned endpoint) still returns ok.

interface UnsubscribeBody {
    endpoint?: unknown;
}

export async function POST(request: Request) {
    const supabase = await createClient();
    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) {
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
        .eq('endpoint', endpoint);
    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
