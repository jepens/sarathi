import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { listApprovedTemplates } from '@/lib/whatsapp/templates';
import { whatsappLogger } from '@/lib/utils/logger';
import type { WhatsAppApiError } from '@/lib/whatsapp/client';
import { requireEnvIntegration } from '@/lib/settings/org-context';

// GET /api/chat/templates
// Returns APPROVED message templates for the WABA. Used by the
// SendTemplateDialog to populate its picker. Members of the default org only —
// the WABA behind the env credentials is Sailendra's.

export const runtime = 'nodejs';

export async function GET() {
    const supabase = await createClient();
    const access = await requireEnvIntegration('whatsapp', supabase);
    if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
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
