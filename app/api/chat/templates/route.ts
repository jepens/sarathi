import { NextResponse } from 'next/server';
import { listApprovedTemplates } from '@/lib/whatsapp/templates';
import { whatsappLogger } from '@/lib/utils/logger';
import type { WhatsAppApiError } from '@/lib/whatsapp/client';
import { accessDeniedResponse } from '@/lib/settings/org-context';
import { requireWhatsAppIntegration } from '@/lib/whatsapp/integration';

// GET /api/chat/templates
// Returns APPROVED message templates for the WABA of the caller's org. Used
// by the SendTemplateDialog to populate its picker. An org without a WhatsApp
// number of its own gets 403 before Meta is called.

export const runtime = 'nodejs';

export async function GET() {
    const access = await requireWhatsAppIntegration();
    if (!access.ok) return accessDeniedResponse(access);

    try {
        const templates = await listApprovedTemplates(access.creds);
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
