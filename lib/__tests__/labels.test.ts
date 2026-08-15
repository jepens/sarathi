import { describe, it, expect } from 'vitest';
import {
    labelColor,
    normalizeLabelName,
    sortLabels,
    LABEL_COLORS,
    LABEL_COLOR_KEYS,
    DEFAULT_LABEL_COLOR,
    MAX_LABEL_NAME,
} from '@/lib/labels';

describe('labelColor', () => {
    it('resolves a known key to its palette entry', () => {
        expect(labelColor('emerald').key).toBe('emerald');
        expect(labelColor('sky').chip).toContain('bg-sky-100');
    });

    it('falls back to the default colour for unknown / null / empty keys', () => {
        expect(labelColor('chartreuse').key).toBe(DEFAULT_LABEL_COLOR);
        expect(labelColor(null).key).toBe(DEFAULT_LABEL_COLOR);
        expect(labelColor(undefined).key).toBe(DEFAULT_LABEL_COLOR);
        expect(labelColor('').key).toBe(DEFAULT_LABEL_COLOR);
    });

    it('every palette entry carries complete, non-empty class strings', () => {
        for (const c of LABEL_COLORS) {
            expect(c.dot).toMatch(/^bg-\w+-500$/);
            expect(c.swatch).toMatch(/^bg-\w+-500$/);
            expect(c.chip).toContain('dark:');
            expect(c.name.length).toBeGreaterThan(0);
        }
    });

    it('the default colour key exists in the palette', () => {
        expect(LABEL_COLOR_KEYS).toContain(DEFAULT_LABEL_COLOR);
    });
});

describe('normalizeLabelName', () => {
    it('trims and collapses inner whitespace', () => {
        expect(normalizeLabelName('  Pesanan   Baru  ')).toBe('Pesanan Baru');
        expect(normalizeLabelName('VIP\t\nklien')).toBe('VIP klien');
    });

    it('caps length at MAX_LABEL_NAME', () => {
        const long = 'x'.repeat(MAX_LABEL_NAME + 10);
        expect(normalizeLabelName(long)).toHaveLength(MAX_LABEL_NAME);
    });

    it('returns empty string for blank input', () => {
        expect(normalizeLabelName('    ')).toBe('');
        expect(normalizeLabelName('')).toBe('');
    });
});

describe('sortLabels', () => {
    it('sorts case-insensitively without mutating the input', () => {
        const input = [{ name: 'zebra' }, { name: 'Apel' }, { name: 'baru' }];
        const out = sortLabels(input);
        expect(out.map((l) => l.name)).toEqual(['Apel', 'baru', 'zebra']);
        // original array untouched
        expect(input.map((l) => l.name)).toEqual(['zebra', 'Apel', 'baru']);
    });
});
