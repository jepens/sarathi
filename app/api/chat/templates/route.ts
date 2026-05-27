import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { listApprovedTemplates } from '@/lib/whatsapp/templates';
import { whatsappLogger } from '@/lib/utils/logger';
import type { WhatsAppApiError } from '@/lib/whatsapp/client';

// GET /api/chat/templates
// Returns APPROVED message templates for the WABA. Used by the
// SendTemplateDialog to populate its picker. Authenticated admins only.

export const runtime = 'nodejs';

export async function GET() {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const templates = await listApprovedTemplates();
        return NextResponse.json({ templates });
    } catch (error) {
        whatsappLogger.error('Failed to list templates', error);
        const apiErr = error as WhatsAppApiError;
        if (typeof apiErr.code === 'number') {
            return NextResponse.json(
                { error: apiErr.message, code: apiErr.code },
                { status: 502 }
            );
        }
        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
