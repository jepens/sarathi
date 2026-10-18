import { describe, it, expect } from 'vitest';
import { flowSubmissionSummary } from '@/lib/whatsapp/flow-summary';

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
});
