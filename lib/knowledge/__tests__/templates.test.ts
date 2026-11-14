import { describe, it, expect } from 'vitest';
import { KB_TEMPLATES } from '@/lib/knowledge/templates';

// F10 (owner decision D8): the Knowledge Base templates are offered to every
// org and, once saved, are embedded and quoted by that org's AI. They must hold
// placeholders for the org's own facts, never Sailendra's identity or clients.

const SAILENDRA_IDENTITY =
    /sailendra|nindra|\bMJ\b|8195|kemenkeu|kementerian keuangan|pertamina|phincon|rakernas|2016|jabodetabek/i;

describe('KB templates (F10)', () => {
    it('carry no Sailendra identity, contacts or portfolio', () => {
        for (const t of KB_TEMPLATES) {
            expect(`${t.title} ${t.description} ${t.content}`).not.toMatch(SAILENDRA_IDENTITY);
        }
    });

    it('leave the business facts to the org as [ISI: ...] placeholders', () => {
        for (const t of KB_TEMPLATES) {
            expect(t.content).toContain('[ISI');
        }
        const layanan = KB_TEMPLATES.find((t) => t.id === 'layanan-dan-paket');
        expect(layanan?.content).toContain('[ISI: nama bisnis]');
    });
});
