import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeSupabase } from './fakeSupabase';
import {
    firstOtherNumberLimitNote,
    firstOtherNumberNote,
    isOtherNumberRow,
    otherNumberLabel,
    otherNumberLimitNotice,
    otherNumberMetadata,
    otherNumberMode,
    otherNumberNotice,
    otherNumberOf,
    otherNumberSeen,
    resetOtherNumberState,
} from '@/lib/whatsapp/other-number';

// Events of the WABA's other numbers (Fase 2 task 2.2a, phase 0): the mode
// switch, the hashed reference (never the id), the "new number" lookup and the
// once-a-day note. Fake ids and numbers only.

const OTHER = '100000000000002';

beforeEach(() => {
    resetOtherNumberState();
});

describe('otherNumberOf / otherNumberLabel', () => {
    it('hashes the id and keeps only the last four display digits', () => {
        const other = otherNumberOf(OTHER, '+62 812-0000-1234');
        expect(other.ref).toMatch(/^h[0-9a-f]{10}$/);
        expect(other.last4).toBe('1234');
        expect(otherNumberLabel(other)).toBe(`phone_number_id ${other.ref}; nomor berakhiran 1234`);
        expect(JSON.stringify(other)).not.toContain(OTHER);
        // The same id always gives the same reference.
        expect(otherNumberOf(OTHER, null).ref).toBe(other.ref);
    });

    it('without a usable display number the label is the reference alone', () => {
        for (const display of [undefined, null, 42, '', '12']) {
            const other = otherNumberOf(OTHER, display);
            expect(other.last4).toBeNull();
            expect(otherNumberLabel(other)).toBe(`phone_number_id ${other.ref}`);
        }
    });
});

describe('otherNumberMode', () => {
    it.each([
        ['', 'drop', undefined],
        ['drop', 'drop', undefined],
        [' DROP ', 'drop', undefined],
        ['"drop"', 'drop', undefined],
        ['process', 'store', undefined],
        [" 'Process' ", 'store', undefined],
        ['store', 'store', undefined],
        ['proses', 'store', '"proses"'],
        ['off', 'store', '"off"'],
        ['"drop', 'store', '"drop"'],
        ['<script>', 'store', '"script"'],
        // Longer: more likely something pasted into the wrong variable (even a
        // secret), so only its length is reported.
        ['EAAG' + 'x'.repeat(60), 'store', 'nilai 64 karakter'],
        ['abcdefghijkl', 'store', '"abcdefghijkl"'], // 12 characters: still quoted
        ['abcdefghijklm', 'store', 'nilai 13 karakter'],
    ])('%j means %s', (raw, mode, unknownValue) => {
        expect(otherNumberMode(raw)).toEqual(unknownValue === undefined ? { mode } : { mode, unknownValue });
    });
});

describe('otherNumberSeen', () => {
    const other = otherNumberOf(OTHER, null);

    it('asks ops_events for a webhook_unrouted report of this number in the last 7 days, once per process', async () => {
        const fake = makeFakeSupabase({ resolve: () => ({ data: [], error: null }) });
        const now = Date.parse('2026-10-18T10:00:00Z');
        expect(await otherNumberSeen(fake.client, other, now)).toBe('new');
        expect(fake.calls).toEqual([
            expect.objectContaining({
                table: 'ops_events',
                op: 'select',
                filters: [
                    ['eq', 'kind', 'webhook_unrouted'],
                    ['like', 'detail', `phone_number_id ${other.ref};%`],
                    ['gte', 'minute', '2026-10-11T10:00:00.000Z'],
                ],
                limitN: 1,
            }),
        ]);
        expect(await otherNumberSeen(fake.client, other, now)).toBe('known');
        expect(fake.calls).toHaveLength(1);
    });

    it('a number reported before is not new', async () => {
        const fake = makeFakeSupabase({ resolve: () => ({ data: [{ id: 7 }], error: null }) });
        expect(await otherNumberSeen(fake.client, other)).toBe('known');
    });

    it('a read error is reported as unchecked (alerted, not taken for known), and the next event looks again', async () => {
        let fail = true;
        const fake = makeFakeSupabase({ resolve: () => (fail ? { data: null, error: { code: '57014' } } : { data: [{ id: 1 }], error: null }) });
        expect(await otherNumberSeen(fake.client, other)).toBe('unchecked');
        fail = false;
        expect(await otherNumberSeen(fake.client, other)).toBe('known');
        expect(fake.calls).toHaveLength(2);
    });

    it('concurrent callers share one lookup and only the first gets true', async () => {
        let release: (v: { data: unknown[]; error: null }) => void = () => {};
        const fake = makeFakeSupabase({ resolve: () => new Promise((r) => { release = r; }) });
        const first = otherNumberSeen(fake.client, other);
        let secondDone = false;
        const second = otherNumberSeen(fake.client, other).then((seen) => {
            secondDone = true;
            return seen;
        });
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        // The second caller waits for the shared lookup before it returns, so
        // its event is not recorded before the lookup ran.
        expect(secondDone).toBe(false);
        release({ data: [], error: null });
        expect(await first).toBe('new');
        expect(await second).toBe('known');
        expect(fake.calls).toHaveLength(1);
    });
});

describe('the note for the operators', () => {
    it('comes once a day per chat', () => {
        const t0 = Date.parse('2026-10-18T10:00:00Z');
        expect(firstOtherNumberNote('org:62800', t0)).toBe(true);
        expect(firstOtherNumberNote('org:62800', t0 + 60_000)).toBe(false);
        expect(firstOtherNumberNote('org:62899', t0 + 60_000)).toBe(true);
        expect(firstOtherNumberNote('org:62800', t0 + 24 * 60 * 60 * 1000)).toBe(true);
    });

    it('names the other number by its last digits, or its reference', () => {
        expect(otherNumberNotice(otherNumberOf(OTHER, '6281200001234'))).toContain('nomor berakhiran 1234');
        const bare = otherNumberOf(OTHER, null);
        expect(otherNumberNotice(bare)).toContain(bare.ref);
        expect(otherNumberNotice(bare)).toContain('AI tidak membalasnya');
        expect(otherNumberNotice(bare)).toContain('kirim template');
        expect(otherNumberLimitNotice(bare)).toContain('melebihi batas per menit');
    });

    it('the "over the limit" note comes once a minute per chat', () => {
        const t0 = Date.parse('2026-10-18T10:00:00Z');
        expect(firstOtherNumberLimitNote('org:62800', t0)).toBe(true);
        expect(firstOtherNumberLimitNote('org:62800', t0 + 30_000)).toBe(false);
        expect(firstOtherNumberLimitNote('org:62800', t0 + 60_000)).toBe(true);
    });
});

describe('the metadata mark', () => {
    it('marks a stored message and recognises only that mark', () => {
        const other = otherNumberOf(OTHER, null);
        expect(isOtherNumberRow(otherNumberMetadata(other))).toBe(true);
        for (const metadata of [null, undefined, {}, { other_number: 1 }, 'other_number', []]) {
            expect(isOtherNumberRow(metadata)).toBe(false);
        }
    });
});
