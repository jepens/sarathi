import { describe, it, expect } from 'vitest';
import {
    normalizePhone,
    sourceLabel,
    fieldForHeader,
    leadToCsvRow,
    leadInputSchema,
    type LeadCsvSource,
} from '@/lib/leads/schema';

describe('normalizePhone', () => {
    it('normalizes Indonesian formats to bare 62… digits', () => {
        expect(normalizePhone('08123456789')).toBe('628123456789');
        expect(normalizePhone('0812 3456 789')).toBe('628123456789');
        expect(normalizePhone('+62 812 3456 789')).toBe('628123456789');
        expect(normalizePhone('8123456789')).toBe('628123456789'); // bare local mobile
    });

    it('returns null for empty / non-numeric input', () => {
        expect(normalizePhone('')).toBeNull();
        expect(normalizePhone(null)).toBeNull();
        expect(normalizePhone(undefined)).toBeNull();
        expect(normalizePhone('not a phone')).toBeNull();
    });

    it('rejects implausible lengths and foreign numbers (no fake identities)', () => {
        expect(normalizePhone('0812')).toBeNull(); // too short
        expect(normalizePhone('1234567890')).toBeNull(); // not 62…, not 0/8-leading
        expect(normalizePhone('62' + '8'.repeat(20))).toBeNull(); // too long
    });
});

describe('sourceLabel', () => {
    it('maps known sources and treats null/whatsapp as WhatsApp', () => {
        expect(sourceLabel(null)).toBe('WhatsApp');
        expect(sourceLabel(undefined)).toBe('WhatsApp');
        expect(sourceLabel('whatsapp')).toBe('WhatsApp');
        expect(sourceLabel('instagram')).toBe('Instagram');
        expect(sourceLabel('event')).toBe('Event / Pameran');
        expect(sourceLabel('walk_in')).toBe('Walk-in');
    });

    it('falls back to the raw value for unknown sources', () => {
        expect(sourceLabel('tiktok')).toBe('tiktok');
    });
});

describe('fieldForHeader', () => {
    it('maps canonical and synonym headers (case/spacing-insensitive)', () => {
        expect(fieldForHeader('nama')).toBe('contact_name');
        expect(fieldForHeader('Nama Lengkap')).toBe('contact_name');
        expect(fieldForHeader('No. HP')).toBe('phone_number');
        expect(fieldForHeader('whatsapp')).toBe('phone_number');
        expect(fieldForHeader('jumlah_pax')).toBe('participant_count');
        expect(fieldForHeader('PAX')).toBe('participant_count');
    });

    it('returns null for an unrecognized header', () => {
        expect(fieldForHeader('kolom_aneh')).toBeNull();
    });
});

describe('leadToCsvRow (export ↔ import round-trip)', () => {
    const base: LeadCsvSource = {
        contact_name: 'Budi',
        company: 'PT Astra',
        phone_number: '628123456789',
        email: 'b@x.co',
        event_interest: 'Wedding',
        participant_count: 200,
        location_pref: 'Bandung',
        event_date_pref: '2026-09-12',
        event_goals: 'Resepsi',
        budget_range: '50jt',
        source: 'event',
        lead_stage: 'qualifying',
        assigned_to: 'Sari',
        notes: 'pameran',
    };

    it('maps to the same Indonesian headers as the import template', () => {
        expect(leadToCsvRow(base)).toEqual({
            nama: 'Budi',
            instansi: 'PT Astra',
            nomor_hp: '628123456789',
            email: 'b@x.co',
            jenis_acara: 'Wedding',
            jumlah_pax: '200',
            lokasi: 'Bandung',
            tanggal: '2026-09-12',
            budget: '50jt',
            tujuan: 'Resepsi',
            sumber: 'event',
            stage: 'qualifying',
            pic: 'Sari',
            catatan: 'pameran',
        });
    });

    it('blanks a synthetic phone-less identity so it re-imports cleanly', () => {
        expect(leadToCsvRow({ ...base, phone_number: 'manual:abc-123' }).nomor_hp).toBe('');
    });

    it('blanks a WhatsApp/null source (not a re-importable value)', () => {
        expect(leadToCsvRow({ ...base, source: null }).sumber).toBe('');
        expect(leadToCsvRow({ ...base, source: 'whatsapp' }).sumber).toBe('');
    });

    it('renders nullish fields as empty strings', () => {
        const row = leadToCsvRow({ ...base, contact_name: null, participant_count: null, notes: null });
        expect(row.nama).toBe('');
        expect(row.jumlah_pax).toBe('');
        expect(row.catatan).toBe('');
    });
});

describe('leadInputSchema', () => {
    it('requires at least one of name / phone / email', () => {
        expect(leadInputSchema.safeParse({ contact_name: 'Budi' }).success).toBe(true);
        expect(leadInputSchema.safeParse({ phone_number: '08123456789' }).success).toBe(true);
        expect(leadInputSchema.safeParse({ email: 'b@x.co' }).success).toBe(true);
        expect(leadInputSchema.safeParse({ notes: 'cuma catatan' }).success).toBe(false);
        expect(leadInputSchema.safeParse({}).success).toBe(false);
    });

    it('applies source/stage defaults', () => {
        const r = leadInputSchema.parse({ contact_name: 'Budi' });
        expect(r.source).toBe('manual');
        expect(r.lead_stage).toBe('new');
    });
});
