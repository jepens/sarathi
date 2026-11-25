import { verifyAppWebhook } from '@/lib/whatsapp/webhook/handshake';
import { processAppWebhook } from '@/lib/whatsapp/webhook/pipeline';

// The webhook URL of one client Meta app (Fase 2 task 2.2c):
// /api/webhook/whatsapp/<whatsapp_apps.webhook_key>. The key only routes;
// trust comes from the app's own signature (POST) and verify token (GET),
// both read from Vault. The bare URL (../route.ts) still serves the env app.

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
    const { key } = await params;
    return verifyAppWebhook(request, key);
}

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
    const { key } = await params;
    return processAppWebhook(request, key);
}
