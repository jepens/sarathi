import { describe, it, expect } from 'vitest';
import {
    applyQuickReplyVars,
    parseSlashQuery,
    filterQuickReplies,
    type QuickReply,
} from '@/lib/quick-replies';

describe('applyQuickReplyVars', () => {
    it('fills all three variables from chat data', () => {
        const out = applyQuickReplyVars('Halo {nama}, untuk acara {event} di {perusahaan} ya', {
            nama: 'Budi',
            perusahaan: 'SIEMENS',
            event: 'Gathering 2026',
        });
        expect(out).toBe('Halo Budi, untuk acara Gathering 2026 di SIEMENS ya');
    });

    it('uses natural fallbacks when values are missing/blank', () => {
        expect(applyQuickReplyVars('Halo {nama}!', { nama: null })).toBe('Halo Kak!');
        expect(applyQuickReplyVars('Halo {nama}!', { nama: '   ' })).toBe('Halo Kak!');
        expect(applyQuickReplyVars('acara {event} di {perusahaan}', {})).toBe(
            'acara acara Anda di perusahaan Anda',
        );
    });

    it('is case-insensitive and tolerates inner spaces; replaces every occurrence', () => {
        expect(applyQuickReplyVars('{NAMA} & { nama }', { nama: 'Sari' })).toBe('Sari & Sari');
    });

    it('leaves unknown tokens untouched', () => {
        expect(applyQuickReplyVars('Hi {nama} {unknown}', { nama: 'A' })).toBe('Hi A {unknown}');
    });

    it('treats "$" in a value literally (no $-replacement-pattern corruption)', () => {
        expect(applyQuickReplyVars('X {perusahaan}', { perusahaan: 'Toko $$ Murah' })).toBe(
            'X Toko $$ Murah',
        );
        // "$&" must NOT re-insert the matched token.
        expect(applyQuickReplyVars('X {perusahaan}', { perusahaan: 'A $& B' })).toBe('X A $& B');
    });

    it('does not re-expand a token that appears inside a substituted value', () => {
        // {nama} → "{event}" must stay literal, not become "Gala".
        expect(applyQuickReplyVars('Halo {nama}', { nama: '{event}', event: 'Gala' })).toBe(
            'Halo {event}',
        );
    });
});

describe('parseSlashQuery', () => {
    it('returns the query for a bare slash token', () => {
        expect(parseSlashQuery('/')).toBe('');
        expect(parseSlashQuery('/har')).toBe('har');
        expect(parseSlashQuery('/HARGA')).toBe('HARGA');
    });

    it('returns null when it is not a slash trigger', () => {
        expect(parseSlashQuery('')).toBeNull();
        expect(parseSlashQuery('harga')).toBeNull();
        expect(parseSlashQuery('/harga oke')).toBeNull(); // space → no longer a trigger
        expect(parseSlashQuery('halo /x')).toBeNull();
    });
});

describe('filterQuickReplies', () => {
    const items: QuickReply[] = [
        { id: '1', shortcut: 'harga', content: 'Untuk paket kami mulai dari...' },
        { id: '2', shortcut: 'lokasi', content: 'Kantor kami di Jakarta, maps: ...' },
        { id: '3', shortcut: 'jam', content: 'Kami buka jam 9-17 (harga tetap)' },
    ];

    it('returns all items for an empty query', () => {
        expect(filterQuickReplies(items, '')).toHaveLength(3);
        expect(filterQuickReplies(items, '   ')).toHaveLength(3);
    });

    it('prefix mode matches shortcut start only', () => {
        expect(filterQuickReplies(items, 'ha', { prefix: true }).map((i) => i.id)).toEqual(['1']);
        // "harga" appears in item 3's content but prefix mode ignores content.
        expect(filterQuickReplies(items, 'lok', { prefix: true }).map((i) => i.id)).toEqual(['2']);
    });

    it('substring mode matches shortcut OR content, case-insensitively', () => {
        // "harga" is in item 1's shortcut and item 3's content.
        expect(filterQuickReplies(items, 'HARGA').map((i) => i.id)).toEqual(['1', '3']);
        expect(filterQuickReplies(items, 'jakarta').map((i) => i.id)).toEqual(['2']);
    });
});
