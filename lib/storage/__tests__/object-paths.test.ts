import { describe, it, expect } from 'vitest';
import { isOrgScopedObjectPath, proposalObjectKey } from '@/lib/storage/object-paths';

const ORG = '5a11e024-0001-4000-8000-000000000001';
const OTHER = '0b0e6c1e-1111-4222-8333-444455556666';

describe('proposalObjectKey', () => {
    it('prefixes the key with the org folder the storage policy checks', () => {
        expect(proposalObjectKey(ORG, '6281234567890', 'abc')).toBe(
            `${ORG}/6281234567890/abc.pdf`
        );
    });
});

describe('isOrgScopedObjectPath', () => {
    it('accepts a file inside the org folder', () => {
        expect(isOrgScopedObjectPath(`${ORG}/1700000000000_brosur.pdf`, ORG)).toBe(true);
        expect(isOrgScopedObjectPath(`${ORG}/sub/file name (1).txt`, ORG)).toBe(true);
    });

    it("rejects another org's folder, legacy root paths and the bare prefix", () => {
        expect(isOrgScopedObjectPath(`${OTHER}/x.pdf`, ORG)).toBe(false);
        expect(isOrgScopedObjectPath('1700000000000_brosur.pdf', ORG)).toBe(false);
        expect(isOrgScopedObjectPath(`${ORG}/`, ORG)).toBe(false);
        expect(isOrgScopedObjectPath(`${ORG}x/file.pdf`, ORG)).toBe(false);
    });

    it('rejects traversal and odd segments', () => {
        expect(isOrgScopedObjectPath(`${ORG}/../${OTHER}/x.pdf`, ORG)).toBe(false);
        expect(isOrgScopedObjectPath(`${ORG}/./x.pdf`, ORG)).toBe(false);
        expect(isOrgScopedObjectPath(`${ORG}//x.pdf`, ORG)).toBe(false);
        expect(isOrgScopedObjectPath(`${ORG}/a\\..\\b.pdf`, ORG)).toBe(false);
        expect(isOrgScopedObjectPath(`${ORG}/a\u0000.pdf`, ORG)).toBe(false);
    });

    it('rejects non-strings and an empty org', () => {
        expect(isOrgScopedObjectPath(undefined, ORG)).toBe(false);
        expect(isOrgScopedObjectPath(42, ORG)).toBe(false);
        expect(isOrgScopedObjectPath('/x.pdf', '')).toBe(false);
    });
});
