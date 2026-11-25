import { NextResponse } from 'next/server';
import { whatsappLogger } from '@/lib/utils/logger';
import { describeErrorForOps } from '@/lib/ops/events';
import { vaultWebhookApp } from '@/lib/whatsapp/credentials';
import { serviceRoleClient } from '@/lib/whatsapp/webhook/service-client';
import { WEBHOOK_KEY, verifyTokenMatches } from '@/lib/whatsapp/webhook/verify';

// Meta's verification GET of a per-app webhook URL (Fase 2 task 2.2c): the
// challenge is echoed only for an active app whose stored verify token hash
// matches. No env or plaintext fallback; the token and the key are never
// logged.

export async function verifyAppWebhook(request: Request, key: string): Promise<NextResponse> {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    if (WEBHOOK_KEY.test(key) && mode === 'subscribe' && token && challenge) {
        const supabase = serviceRoleClient();
        if (supabase) {
            try {
                const app = await vaultWebhookApp(supabase, key);
                if (app && app.status === 'active' && verifyTokenMatches(token, app.verifyTokenSha256)) {
                    whatsappLogger.info(`Webhook verified successfully (app ${app.appId})`);
                    return new NextResponse(challenge, { status: 200 });
                }
            } catch (error) {
                whatsappLogger.error(`Webhook verification could not read the app (${describeErrorForOps(error)})`);
            }
        }
    }

    whatsappLogger.warn('Webhook verification failed');
    return new NextResponse('Forbidden', { status: 403 });
}
