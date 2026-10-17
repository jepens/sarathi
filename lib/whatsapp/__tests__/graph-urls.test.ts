import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every WhatsApp Cloud API call goes to the one Graph API version of
// lib/whatsapp/graph.ts (tracker 2.7, audit KUA-16), so raising the version
// changes exactly one place. Fake ids and tokens only.

vi.mock('@/lib/settings/app-settings', () => ({
    getWhatsAppAccessToken: vi.fn(async () => 'token-palsu'),
    getWhatsAppPhoneNumberId: vi.fn(async () => 'pnid-palsu'),
    getWhatsAppBusinessAccountId: vi.fn(async () => 'waba-palsu'),
}));

import { GRAPH_API_VERSION, graphUrl } from '@/lib/whatsapp/graph';
import {
    downloadWhatsAppMedia,
    sendWhatsAppMedia,
    sendWhatsAppMessage,
    uploadWhatsAppMedia,
} from '@/lib/whatsapp/client';
import { listApprovedTemplates, sendTemplateMessage } from '@/lib/whatsapp/templates';

const GRAPH = 'https://graph.facebook.com/v25.0';
const LOOKASIDE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=palsu';

let urls: string[] = [];
let bodies: unknown[] = [];

function reply(url: string): Response {
    const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === LOOKASIDE) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (url.endsWith('/messages')) return json({ messages: [{ id: 'wamid.palsu' }] });
    if (url.endsWith('/media')) return json({ id: 'media-palsu' });
    if (url.includes('/message_templates')) return json({ data: [] });
    return json({ url: LOOKASIDE, mime_type: 'image/jpeg' }); // GET /{media-id}
}

beforeEach(() => {
    urls = [];
    bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
        return reply(url);
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Graph API version', () => {
    it('is v25.0 (v21.0 stops working on 2027-01-21), built in one place', () => {
        expect(GRAPH_API_VERSION).toBe('v25.0');
        expect(graphUrl('pnid/messages')).toBe(`${GRAPH}/pnid/messages`);
        expect(graphUrl('/pnid/media')).toBe(`${GRAPH}/pnid/media`);
    });

    it('text, media upload and media send use it', async () => {
        await sendWhatsAppMessage('628000000000', 'halo');
        await uploadWhatsAppMedia(new Blob(['x']), 'a.jpg', 'image/jpeg');
        await sendWhatsAppMedia('628000000000', { kind: 'image', mediaId: 'media-palsu' });
        expect(urls).toEqual([`${GRAPH}/pnid-palsu/messages`, `${GRAPH}/pnid-palsu/media`, `${GRAPH}/pnid-palsu/messages`]);
    });

    it('a text send names its type and recipient_type, as Meta\'s v25.0 reference requires', async () => {
        await sendWhatsAppMessage('628000000000', 'halo', undefined, 'wamid.dikutip');
        expect(bodies[0]).toEqual({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '628000000000',
            context: { message_id: 'wamid.dikutip' },
            type: 'text',
            text: { body: 'halo' },
        });
    });

    it('inbound media: the media id is resolved on it, the bytes come from the lookaside url', async () => {
        const media = await downloadWhatsAppMedia('media-palsu');
        expect(media.size).toBe(3);
        expect(urls).toEqual([`${GRAPH}/media-palsu`, LOOKASIDE]);
    });

    it('template list and template send (with the Flow definition lookup) use it', async () => {
        await listApprovedTemplates();
        await sendTemplateMessage({ to: '628000000000', templateName: 'tpl_palsu', language: 'id' });
        expect(urls).toEqual([
            `${GRAPH}/waba-palsu/message_templates?status=APPROVED&limit=100`,
            `${GRAPH}/waba-palsu/message_templates?name=tpl_palsu&limit=25`,
            `${GRAPH}/pnid-palsu/messages`,
        ]);
        expect(urls.some((u) => u.includes('v21.0'))).toBe(false);
    });
});
