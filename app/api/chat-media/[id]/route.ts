import { NextResponse } from 'next/server';
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { CHAT_MEDIA_BUCKET, chatMediaObjectPath } from '@/lib/storage/chat-media';

// GET /api/chat-media/<message id>: the dashboard's only way to a chat photo,
// document, voice note or video (tracker 1.11, audit KEA-4). The chat-media
// bucket is private (migration 0067), so ChatWindow renders this stable
// same-origin URL instead of a Storage URL, and the route answers with a 302
// to a signed URL that lives 10 minutes.
//
// Authorisation runs twice, both times in the member's own session (the
// cookie-bound RLS client; never the service role here):
//   1. the message row is read under whatsapp_messages RLS AND filtered to the
//      member's org, and its key must lie in that org's folder
//      (chatMediaObjectPath; old rows hold the public URL, new ones the bare
//      key);
//   2. createSignedUrl checks the storage policy "chat-media org members"
//      (0058), which again requires membership of the key's first folder.
// Every failure is the same bare 404 (nothing tells a foreign id from a
// missing one), and nothing logs the key, the URL, the phone or the id.
//
// The redirect may be cached privately for 5 minutes, half the signed URL's
// lifetime, so a cached redirect never points at an expired token. No
// `download` option: PDFs keep opening inline in the browser.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_URL_SECONDS = 600;
const REDIRECT_CACHE_CONTROL = 'private, max-age=300';

function notFound(): NextResponse {
    return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId } = access;

    const { id } = await params;
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) return notFound();

    const { data: row, error } = await supabase
        .from('whatsapp_messages')
        .select('media_url')
        .eq('org_id', orgId)
        .eq('id', id)
        .maybeSingle<{ media_url: string | null }>();
    if (error) {
        console.error('chat-media: message lookup failed', { code: error.code });
        return notFound();
    }

    const path = chatMediaObjectPath(row?.media_url, orgId);
    if (!path) return notFound();

    const { data: signed, error: signError } = await supabase.storage
        .from(CHAT_MEDIA_BUCKET)
        .createSignedUrl(path, SIGNED_URL_SECONDS);
    if (signError || !signed?.signedUrl) {
        // e.g. the object is gone, or Storage is unreachable. Status only.
        const status = signError && 'status' in signError ? signError.status : null;
        console.warn('chat-media: could not sign the object', { status: typeof status === 'number' ? status : null });
        return notFound();
    }

    const response = NextResponse.redirect(signed.signedUrl, 302);
    response.headers.set('Cache-Control', REDIRECT_CACHE_CONTROL);
    return response;
}
