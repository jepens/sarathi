import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every WhatsApp Cloud API call goes to the one Graph API version of
// lib/whatsapp/graph.ts (tracker 2.7, audit KUA-16), so raising the version
// changes exactly one place, and uses only the credentials it was handed
// (WaCreds, Fase 2 task 2.2b): their number, WABA, token and version. Fake
// ids and tokens only.

import { GRAPH_API_VERSION, graphUrl } from '@/lib/whatsapp/graph';
import {
    describeWhatsAppError,
    downloadWhatsAppMedia,
    makeWhatsAppApiError,
    sendWhatsAppMedia,
    sendWhatsAppMessage,
    uploadWhatsAppMedia,
} from '@/lib/whatsapp/client';
import { listApprovedTemplates, sendTemplateMessage } from '@/lib/whatsapp/templates';

const GRAPH = 'https://graph.facebook.com/v25.0';
const CREDS = {
    orgId: 'aaaaaaaa-0000-4000-8000-00000000000a',
    integrationId: null,
    phoneNumberId: 'pnid-palsu',
    wabaId: 'waba-palsu',
    accessToken: 'token-palsu',
    graphVersion: 'v25.0',
};
const LOOKASIDE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=palsu';

let urls: string[] = [];
let bodies: unknown[] = [];
let auths: Array<string | null> = [];

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
    auths = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        auths.push(new Headers(init?.headers).get('authorization'));
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
        await sendWhatsAppMessage(CREDS, '628000000000', 'halo');
        await uploadWhatsAppMedia(CREDS, new Blob(['x']), 'a.jpg', 'image/jpeg');
        await sendWhatsAppMedia(CREDS, '628000000000', { kind: 'image', mediaId: 'media-palsu' });
        expect(urls).toEqual([`${GRAPH}/pnid-palsu/messages`, `${GRAPH}/pnid-palsu/media`, `${GRAPH}/pnid-palsu/messages`]);
        expect(auths).toEqual(['Bearer token-palsu', 'Bearer token-palsu', 'Bearer token-palsu']);
    });

    it('an AI reply (no reply context) names its type and recipient_type, as Meta\'s v25.0 reference requires', async () => {
        await sendWhatsAppMessage(CREDS, '628000000000', 'halo');
        expect(bodies[0]).toEqual({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '628000000000',
            type: 'text',
            text: { body: 'halo' },
        });
    });

    it('a send to a BSUID uses recipient (never to)', async () => {
        await sendWhatsAppMessage(CREDS, 'ID.palsu', 'halo');
        expect(bodies[0]).toEqual({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            recipient: 'ID.palsu',
            type: 'text',
            text: { body: 'halo' },
        });
        expect(bodies[0]).not.toHaveProperty('to');
    });

    it('a manual reply with a quote keeps its context, type and recipient_type', async () => {
        await sendWhatsAppMessage(CREDS, '628000000000', 'halo', 'wamid.dikutip');
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
        const media = await downloadWhatsAppMedia(CREDS, 'media-palsu');
        expect(media.size).toBe(3);
        expect(urls).toEqual([`${GRAPH}/media-palsu`, LOOKASIDE]);
        expect(auths).toEqual(['Bearer token-palsu', 'Bearer token-palsu']);
    });

    it('template list and template send (with the Flow definition lookup) use it', async () => {
        await listApprovedTemplates(CREDS);
        await sendTemplateMessage(CREDS, { to: '628000000000', templateName: 'tpl_palsu', language: 'id' });
        expect(urls).toEqual([
            `${GRAPH}/waba-palsu/message_templates?status=APPROVED&limit=100`,
            `${GRAPH}/waba-palsu/message_templates?name=tpl_palsu&limit=25`,
            `${GRAPH}/pnid-palsu/messages`,
        ]);
        expect(urls.some((u) => u.includes('v21.0'))).toBe(false);
        expect(auths.every((a) => a === 'Bearer token-palsu')).toBe(true);
    });
});

describe('the credentials of each call', () => {
    it("another number's credentials go to that number, with its token and version, on every call", async () => {
        const other = { ...CREDS, phoneNumberId: 'pnid-lain', wabaId: 'waba-lain', accessToken: 'token-lain', graphVersion: 'v26.0' };
        const V26 = 'https://graph.facebook.com/v26.0';
        await sendWhatsAppMessage(other, '628000000000', 'halo');
        await uploadWhatsAppMedia(other, new Blob(['x']), 'a.jpg', 'image/jpeg');
        await sendWhatsAppMedia(other, '628000000000', { kind: 'image', mediaId: 'media-palsu' });
        await downloadWhatsAppMedia(other, 'media-palsu');
        await listApprovedTemplates(other);
        await sendTemplateMessage(other, { to: '628000000000', templateName: 'tpl_palsu', language: 'id' });
        expect(urls).toEqual([
            `${V26}/pnid-lain/messages`,
            `${V26}/pnid-lain/media`,
            `${V26}/pnid-lain/messages`,
            `${V26}/media-palsu`,
            LOOKASIDE,
            `${V26}/waba-lain/message_templates?status=APPROVED&limit=100`,
            `${V26}/waba-lain/message_templates?name=tpl_palsu&limit=25`,
            `${V26}/pnid-lain/messages`,
        ]);
        expect(auths.every((a) => a === 'Bearer token-lain')).toBe(true);
        expect(auths).toHaveLength(8);
    });

    it('incomplete credentials never reach Meta', async () => {
        const noToken = { ...CREDS, accessToken: '' };
        await expect(sendWhatsAppMessage(noToken, '628000000000', 'halo')).rejects.toThrow('not configured');
        await expect(uploadWhatsAppMedia({ ...CREDS, phoneNumberId: '' }, new Blob(['x']), 'a.jpg', 'image/jpeg')).rejects.toThrow(
            'not configured',
        );
        await expect(sendWhatsAppMedia(noToken, '628000000000', { kind: 'image', mediaId: 'm' })).rejects.toThrow('not configured');
        await expect(downloadWhatsAppMedia(noToken, 'media-palsu')).rejects.toThrow('not configured');
        await expect(sendTemplateMessage(noToken, { to: '628000000000', templateName: 't', language: 'id' })).rejects.toThrow(
            'not configured',
        );
        await expect(listApprovedTemplates(noToken)).rejects.toThrow('not configured');
        await expect(listApprovedTemplates({ ...CREDS, wabaId: null })).rejects.toThrow('WhatsApp Business Account ID not configured');
        expect(urls).toEqual([]);
    });
});

describe('describeWhatsAppError', () => {
    it("keeps Meta's detail for a rejected template parameter (132018, since v23.0)", () => {
        const err = makeWhatsAppApiError({ error: { code: 132018, error_data: { details: 'Param text cannot have new-line/tab characters' } } }, 400);
        expect(describeWhatsAppError(err)).toContain('Param text cannot have new-line/tab characters');
        expect(describeWhatsAppError(err)).toContain('(Kode 132018)');
    });
});
