import { describe, it, expect } from 'vitest';
import { splitHighlight } from '@/lib/highlight';

describe('splitHighlight', () => {
    it('returns a single non-match chunk for an empty/blank query', () => {
        expect(splitHighlight('Hello world', '')).toEqual([{ text: 'Hello world', match: false }]);
        expect(splitHighlight('Hello world', '   ')).toEqual([{ text: 'Hello world', match: false }]);
    });

    it('marks every occurrence, case-insensitively, preserving original case', () => {
        expect(splitHighlight('Hello hELLo', 'hello')).toEqual([
            { text: 'Hello', match: true },
            { text: ' ', match: false },
            { text: 'hELLo', match: true },
        ]);
    });

    it('handles a match at the very start and end', () => {
        expect(splitHighlight('abcabc', 'abc')).toEqual([
            { text: 'abc', match: true },
            { text: 'abc', match: true },
        ]);
    });

    it('treats regex metacharacters in the query literally', () => {
        expect(splitHighlight('harga $5 dan $10', '$5')).toEqual([
            { text: 'harga ', match: false },
            { text: '$5', match: true },
            { text: ' dan $10', match: false },
        ]);
        expect(splitHighlight('a.b.c', '.')).toEqual([
            { text: 'a', match: false },
            { text: '.', match: true },
            { text: 'b', match: false },
            { text: '.', match: true },
            { text: 'c', match: false },
        ]);
    });

    it('returns the whole string as a non-match when nothing matches', () => {
        expect(splitHighlight('abc', 'xyz')).toEqual([{ text: 'abc', match: false }]);
    });
});
