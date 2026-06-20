import { describe, it, expect } from 'vitest';
import { toWhatsAppText } from '@/lib/whatsapp/format';

describe('toWhatsAppText', () => {
    it('returns falsy input unchanged', () => {
        expect(toWhatsAppText('')).toBe('');
    });

    it('converts Markdown bold (** and __) to WhatsApp single-asterisk bold', () => {
        expect(toWhatsAppText('**tebal**')).toBe('*tebal*');
        expect(toWhatsAppText('__tebal__')).toBe('*tebal*');
        // The real leak this guards against: a bold email reaching the customer.
        expect(toWhatsAppText('Hubungi **info@sailendra.co.id**')).toBe('Hubungi *info@sailendra.co.id*');
    });

    it('leaves already-correct WhatsApp bold untouched', () => {
        expect(toWhatsAppText('*halo*')).toBe('*halo*');
    });

    it('turns Markdown headings into a bold line', () => {
        expect(toWhatsAppText('## Paket A')).toBe('*Paket A*');
        expect(toWhatsAppText('### Sub')).toBe('*Sub*');
    });

    it('rewrites Markdown links to "label (url)"', () => {
        expect(toWhatsAppText('[brosur](https://x.co/b)')).toBe('brosur (https://x.co/b)');
    });

    it('converts bullet markers to •', () => {
        expect(toWhatsAppText('- satu')).toBe('• satu');
        expect(toWhatsAppText('* dua')).toBe('• dua');
    });

    it('handles a realistic multi-line WhatsApp reply', () => {
        const input = '## Paket Gold\n**Termasuk:**\n- Dekorasi\n- MC\nInfo: [klik](https://x.co)';
        const expected = '*Paket Gold*\n*Termasuk:*\n• Dekorasi\n• MC\nInfo: klik (https://x.co)';
        expect(toWhatsAppText(input)).toBe(expected);
    });
});
