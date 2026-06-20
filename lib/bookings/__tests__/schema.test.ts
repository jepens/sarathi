import { describe, it, expect } from 'vitest';
import {
    parseRupiah,
    remainingBalance,
    formatRupiah,
    bookingInputSchema,
} from '@/lib/bookings/schema';

describe('parseRupiah', () => {
    it('parses Indonesian-formatted money (dot = thousands)', () => {
        expect(parseRupiah('Rp 75.000.000')).toBe(75_000_000);
        expect(parseRupiah('75.000.000')).toBe(75_000_000);
        expect(parseRupiah('1.500')).toBe(1_500);
    });

    it('does NOT inflate values with a decimal comma (the 100x trap)', () => {
        // "75.000.000,50" must be 75,000,000.5 → rounded, NOT 7.5 billion.
        expect(parseRupiah('75.000.000,50')).toBe(75_000_001);
        expect(parseRupiah('10,5')).toBe(11); // 10.5 rounds half up
        expect(parseRupiah('10,4')).toBe(10);
    });

    it('handles bare numbers and numeric input (rounding fractions)', () => {
        expect(parseRupiah('75000000')).toBe(75_000_000);
        expect(parseRupiah(75_000_000)).toBe(75_000_000);
        expect(parseRupiah(75_000_000.4)).toBe(75_000_000);
    });

    it('returns 0 for empty / non-numeric / nullish / non-finite', () => {
        expect(parseRupiah(null)).toBe(0);
        expect(parseRupiah(undefined)).toBe(0);
        expect(parseRupiah('')).toBe(0);
        expect(parseRupiah('abc')).toBe(0);
        expect(parseRupiah(Infinity)).toBe(0);
        expect(parseRupiah(Number.NaN)).toBe(0);
    });
});

describe('remainingBalance', () => {
    it('subtracts the down-payment from the total', () => {
        expect(remainingBalance(100_000_000, 30_000_000)).toBe(70_000_000);
    });

    it('never goes negative when the DP exceeds the total', () => {
        expect(remainingBalance(50_000_000, 60_000_000)).toBe(0);
    });

    it('handles zero values', () => {
        expect(remainingBalance(100, 0)).toBe(100);
        expect(remainingBalance(0, 0)).toBe(0);
    });
});

describe('formatRupiah', () => {
    it('formats with id-ID thousands separators and an Rp prefix', () => {
        expect(formatRupiah(75_000_000)).toBe('Rp 75.000.000');
        expect(formatRupiah(1_500)).toBe('Rp 1.500');
    });

    it('renders nullish / zero as Rp 0', () => {
        expect(formatRupiah(null)).toBe('Rp 0');
        expect(formatRupiah(undefined)).toBe('Rp 0');
        expect(formatRupiah(0)).toBe('Rp 0');
    });
});

describe('bookingInputSchema', () => {
    it('accepts a minimal booking and applies defaults', () => {
        const r = bookingInputSchema.parse({ customer_name: 'Budi' });
        expect(r.customer_name).toBe('Budi');
        expect(r.total_amount).toBe(0);
        expect(r.dp_amount).toBe(0);
        expect(r.status).toBe('pending');
        expect(r.order_type).toBe('service');
    });

    it('parses money fields without the 100x decimal-comma trap', () => {
        const r = bookingInputSchema.parse({
            customer_name: 'Sari',
            total_amount: '75.000.000,50',
            dp_amount: 'Rp 10.000.000',
        });
        expect(r.total_amount).toBe(75_000_001);
        expect(r.dp_amount).toBe(10_000_000);
    });

    it('requires a non-blank customer name', () => {
        expect(bookingInputSchema.safeParse({ customer_name: '  ' }).success).toBe(false);
        expect(bookingInputSchema.safeParse({}).success).toBe(false);
    });

    it('lowercases the status enum and rejects unknown values', () => {
        expect(bookingInputSchema.parse({ customer_name: 'A', status: 'PAID' }).status).toBe('paid');
        expect(bookingInputSchema.safeParse({ customer_name: 'A', status: 'unknown' }).success).toBe(false);
    });

    it('validates the optional phone and rejects garbage', () => {
        expect(bookingInputSchema.safeParse({ customer_name: 'A', customer_phone: '08123456789' }).success).toBe(true);
        expect(bookingInputSchema.safeParse({ customer_name: 'A', customer_phone: 'not-a-phone' }).success).toBe(false);
        expect(bookingInputSchema.safeParse({ customer_name: 'A', customer_phone: '' }).success).toBe(true);
    });

    it('rejects a fractional headcount instead of flattening it', () => {
        expect(bookingInputSchema.safeParse({ customer_name: 'A', headcount: '1.5' }).success).toBe(false);
        expect(bookingInputSchema.parse({ customer_name: 'A', headcount: '300' }).headcount).toBe(300);
    });
});
