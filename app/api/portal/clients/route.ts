import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { isPortalConfigured } from '@/lib/portal/config';
import { searchPortalClients } from '@/lib/portal/client';

// Search proxy for the handoff picker. The browser calls THIS route (same
// origin, auth-gated); we call the Portal server-to-server with the shared
// token. This keeps PORTAL_INTAKE_TOKEN server-side and dodges CORS, while
// staying snappy for debounced typeahead (a plain GET, not a serialized action).

export async function GET(request: Request) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isPortalConfigured()) {
        return NextResponse.json({ error: 'Portal belum dikonfigurasi' }, { status: 503 });
    }

    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') ?? '').trim();
    // Require a couple of characters before hitting the Portal — avoids dumping
    // the whole client list on an empty/one-char query.
    if (q.length < 2) {
        return NextResponse.json({ clients: [] });
    }

    try {
        const clients = await searchPortalClients(q);
        return NextResponse.json({ clients });
    } catch (err) {
        // Upstream/transport failure → 502 Bad Gateway (we're a proxy here).
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Gagal mencari klien Portal' },
            { status: 502 }
        );
    }
}
