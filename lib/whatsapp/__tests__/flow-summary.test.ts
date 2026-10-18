import { describe, it, expect } from 'vitest';
import {
    contactCardSummary,
    flowSubmissionSummary,
    isStoredOtherMessageType,
    otherMessagePreview,
    otherMessageSummary,
} from '@/lib/whatsapp/flow-summary';

// A lone surrogate: half of an emoji, not valid UTF-8 (the database refuses it).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The summary of a Flow submission to another number of the WABA, stored for
// the operators (the form is unknown to this app). Fake answers only.

describe('flowSubmissionSummary', () => {
    it('lists the answers of a JSON string, without the flow token or empty fields', () => {
        const raw = JSON.stringify({ flow_token: 'token-palsu', nama: 'Budi Palsu', peserta: 40, setuju: true, catatan: '', x: null });
        expect(flowSubmissionSummary(raw)).toBe('📋 Form WhatsApp dikirim\nnama: Budi Palsu\npeserta: 40\nsetuju: true');
    });

    it('accepts an object, joins lists and shows nested values as JSON', () => {
        expect(flowSubmissionSummary({ pilihan: ['a', 'b'], alamat: { kota: 'Bandung' } })).toBe(
            '📋 Form WhatsApp dikirim\npilihan: a, b\nalamat: {"kota":"Bandung"}',
        );
    });

    it('cuts long values and stops after 12 answers', () => {
        const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 'x'.repeat(300)]));
        const lines = flowSubmissionSummary(many).split('\n');
        expect(lines).toHaveLength(13);
        expect(lines[1]).toBe(`f0: ${'x'.repeat(200)}…`);
    });

    it('says so when nothing can be read', () => {
        for (const raw of ['bukan json', '[1,2]', '{}', null, undefined, 42]) {
            expect(flowSubmissionSummary(raw)).toBe('📋 Form WhatsApp dikirim (isian tidak terbaca)');
        }
    });

    it('keeps a value of exactly 200 code points whole and cuts one of 201', () => {
        expect(flowSubmissionSummary({ a: 'x'.repeat(200) })).toBe(`📋 Form WhatsApp dikirim\na: ${'x'.repeat(200)}`);
        expect(flowSubmissionSummary({ a: 'x'.repeat(201) })).toBe(`📋 Form WhatsApp dikirim\na: ${'x'.repeat(200)}…`);
        expect(contactCardSummary([{ name: { formatted_name: 'n'.repeat(250) }, phones: [] }]))
            .toBe(`👤 Kartu kontak dibagikan\n${'n'.repeat(200)}…`);
    });

    it('never cuts an emoji in half', () => {
        const summary = flowSubmissionSummary({ catatan: `${'a'.repeat(199)}😀😀` });
        expect(summary).not.toMatch(LONE_SURROGATE);
        expect(summary).toBe(`📋 Form WhatsApp dikirim\ncatatan: ${'a'.repeat(199)}😀…`);
        expect(contactCardSummary([{ name: { formatted_name: `${'b'.repeat(199)}😀` }, phones: [] }])).not.toMatch(LONE_SURROGATE);
    });
});

describe('otherMessageSummary', () => {
    it('describes the other message types in one line', () => {
        expect(otherMessageSummary({ type: 'button', button: { text: 'Ya, saya tertarik', payload: 'YA' } })).toBe('🔘 Tombol: Ya, saya tertarik');
        expect(otherMessageSummary({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'p2', title: 'Paket B' } } }))
            .toBe('🔘 Pilihan: Paket B');
        expect(otherMessageSummary({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1' } } }))
            .toBe('🔘 Pilihan: b1');
        expect(otherMessageSummary({ type: 'location', location: { name: 'Kantor', address: 'Jl. Contoh 1', latitude: -6.2, longitude: 106.8 } }))
            .toBe('📍 Lokasi: Kantor, Jl. Contoh 1');
        expect(otherMessageSummary({ type: 'location', location: { latitude: -6.2, longitude: 106.8 } })).toBe('📍 Lokasi: -6.2, 106.8');
        expect(otherMessageSummary({ type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } })).toBe('Reaksi: 👍');
        expect(otherMessageSummary({ type: 'reaction', reaction: { message_id: 'wamid.x' } })).toBe('Reaksi: (dihapus)');
        expect(otherMessageSummary({ type: 'unsupported' })).toBe('Pesan jenis "unsupported" (isinya tidak ditampilkan di Sarathi)');
        expect(otherMessageSummary(null)).toBe('Pesan jenis "tidak dikenal" (isinya tidak ditampilkan di Sarathi)');
    });

    it('falls back to the payload, names an unknown interactive subtype, cuts long text and stays on one line', () => {
        expect(otherMessageSummary({ type: 'button', button: { text: '', payload: 'MINTA_INFO' } })).toBe('🔘 Tombol: MINTA_INFO');
        expect(otherMessageSummary({ type: 'button', button: { text: 'y'.repeat(300) } })).toBe(`🔘 Tombol: ${'y'.repeat(200)}…`);
        expect(otherMessageSummary({ type: 'interactive', interactive: { type: 'call_permission_reply' } }))
            .toBe('Pesan interaktif "call_permission_reply" (isinya tidak ditampilkan di Sarathi)');
        expect(otherMessageSummary({ type: 'location', location: { name: 'Kantor\nLantai 2', address: 'Jl. Contoh\n1' } }))
            .toBe('📍 Lokasi: Kantor Lantai 2, Jl. Contoh 1');
    });

    it('stores what the customer wrote, not events where they wrote nothing', () => {
        for (const type of ['button', 'interactive', 'location', 'order', 'unsupported', 'tidak-ada']) expect(isStoredOtherMessageType(type)).toBe(true);
        for (const type of ['system', 'request_welcome', 'reaction']) expect(isStoredOtherMessageType(type)).toBe(false);
    });

    it('keeps a location out of the preview and the push', () => {
        expect(otherMessagePreview({ type: 'location', location: { address: 'Jl. Contoh 1' } })).toBe('📍 Lokasi');
        expect(otherMessagePreview({ type: 'button', button: { text: 'Ya' } })).toBe('🔘 Tombol: Ya');
    });
});

describe('contactCardSummary', () => {
    it('lists each card as name: phones (the typed phone, else the wa_id)', () => {
        expect(
            contactCardSummary([
                { name: { formatted_name: ' Teman Palsu ' }, phones: [{ phone: '+62 800-0000-0099' }, { wa_id: '6280000000098' }] },
                { name: {}, phones: [] },
            ]),
        ).toBe('👤 Kartu kontak dibagikan\nTeman Palsu: +62 800-0000-0099, 6280000000098\ntanpa nama: tanpa nomor');
    });

    it('says so when nothing can be read', () => {
        for (const raw of [null, undefined, 'x', [], [null, 3]]) {
            expect(contactCardSummary(raw)).toBe('👤 Kartu kontak dibagikan (isi tidak terbaca)');
        }
    });
});
