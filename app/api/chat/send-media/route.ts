import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    uploadWhatsAppMedia,
    sendWhatsAppMedia,
    classifyMedia,
    mediaMaxBytes,
    describeWhatsAppError,
    type WhatsAppApiError,
} from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';
import { requireEnvIntegration } from '@/lib/settings/org-context';

const CHAT_MEDIA_BUCKET = 'chat-media';

// Extension for the storage object path — keep the original where sane, else map
// from a couple of common mimes.
function safeExt(filename: string, mime: string): string {
    const fromName = filename.includes('.') ? filename.split('.').pop() : '';
    const ext = (fromName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ext) return ext;
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/png') return 'png';
    if (mime === 'application/pdf') return 'pdf';
    return 'bin';
}

// Manual media send from the chat window: admin uploads a photo/document to the
// customer. Multipart body: { phone_number, file, caption? }.
export async function POST(request: Request) {
    try {
        const supabase = await createClient();
        // Member of the default org only (env WhatsApp credentials) — before
        // the Meta upload/send below.
        const access = await requireEnvIntegration('whatsapp', supabase);
        if (!access.ok) {
            return NextResponse.json({ error: access.error }, { status: access.status });
        }
        const orgId = access.orgId;

        const form = await request.formData();
        const phone_number = form.get('phone_number');
        const caption = form.get('caption');
        const file = form.get('file');

        if (typeof phone_number !== 'string' || !phone_number) {
            return NextResponse.json({ error: 'Missing phone_number' }, { status: 400 });
        }
        if (!(file instanceof File) || file.size === 0) {
            return NextResponse.json({ error: 'Missing file' }, { status: 400 });
        }

        const mime = file.type || 'application/octet-stream';
        const kind = classifyMedia(mime);
        if (!kind) {
            return NextResponse.json(
                {
                    error:
                        'Tipe file tidak didukung. Gunakan gambar (JPG/PNG) atau dokumen (PDF/DOC/XLS/TXT).',
                },
                { status: 415 }
            );
        }
        if (file.size > mediaMaxBytes(kind)) {
            const mb = Math.round(mediaMaxBytes(kind) / (1024 * 1024));
            return NextResponse.json(
                {
                    error: `File terlalu besar. Maksimal ${mb} MB untuk ${kind === 'image' ? 'gambar' : 'dokumen'}.`,
                },
                { status: 413 }
            );
        }

        const captionStr = typeof caption === 'string' && caption.trim() ? caption.trim() : undefined;
        const filename = file.name || (kind === 'image' ? 'image' : 'file');

        // Read the bytes once — reused for the Meta upload and the Storage copy.
        const bytes = new Uint8Array(await file.arrayBuffer());
        const blob = new Blob([bytes], { type: mime });

        // Meta FIRST: if it rejects (e.g. past the 24h window), we don't store a
        // phantom message the customer never received.
        const mediaId = await uploadWhatsAppMedia(blob, filename, mime);
        const sendResult = await sendWhatsAppMedia(phone_number, {
            kind,
            mediaId,
            caption: captionStr,
            filename: kind === 'document' ? filename : undefined,
        });

        // Persist a copy so the dashboard can render it inline (Meta's media
        // expires ~30 days). Non-fatal if it fails — the message was delivered.
        // Sanitise the (client-supplied) phone segment so nothing can inject '/'
        // or '..' into the storage object key; orgId + the random UUID are safe.
        const safePhone = phone_number.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${orgId}/${safePhone}/${crypto.randomUUID()}.${safeExt(filename, mime)}`;
        let mediaUrl: string | null = null;
        const { error: upErr } = await supabase.storage
            .from(CHAT_MEDIA_BUCKET)
            .upload(path, bytes, { contentType: mime, upsert: false });
        if (upErr) {
            whatsappLogger.error('chat-media storage upload failed', upErr);
        } else {
            mediaUrl = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
        }

        const summary = captionStr ?? (kind === 'image' ? '📷 Foto' : `📎 ${filename}`);
        const nowIso = new Date().toISOString();

        const { error: chatError } = await supabase.from('whatsapp_chats').upsert(
            {
                org_id: orgId,
                phone_number,
                last_message: summary,
                last_message_at: nowIso,
                updated_at: nowIso,
            },
            { onConflict: 'org_id,phone_number' }
        );
        if (chatError) throw chatError;

        const { error: msgError } = await supabase.from('whatsapp_messages').insert({
            org_id: orgId,
            phone_number,
            role: 'assistant',
            content: captionStr ?? '',
            media_type: kind,
            media_url: mediaUrl,
            media_mime: mime,
            media_filename: filename,
            wa_message_id: sendResult.waMessageId,
            status: 'sent',
            status_updated_at: nowIso,
        });
        if (msgError) throw msgError;

        whatsappLogger.info(`Admin sent ${kind} to ${phone_number}`);
        return NextResponse.json({ success: true });
    } catch (error) {
        whatsappLogger.error('Error sending admin media', error);
        const apiErr = error as WhatsAppApiError;
        if (typeof apiErr.code === 'number') {
            return NextResponse.json(
                {
                    error: describeWhatsAppError(apiErr),
                    code: apiErr.code,
                    subcode: apiErr.subcode,
                    fbtrace_id: apiErr.fbtraceId,
                },
                { status: 502 }
            );
        }
        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
