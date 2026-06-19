import { z } from 'zod';
import { normalizePhone } from '@/lib/leads/schema';

// Shared booking-intake schema + constants. Used by BOTH the BookingDialog
// (client) and the order server actions (server validation). Client-safe — no
// server-only imports. A "booking" is a row in the `orders` table (event-focused
// for the EO use case; order_type defaults to 'service').

// --- Status ------------------------------------------------------------------
// `orders.status` has NO DB CHECK constraint (free text). These are the values
// the booking UI offers; the existing status-cycle dropdown (with stock +
// WhatsApp side-effects) keeps using its own list. 'shipped' is kept so editing
// a legacy product order doesn't land on an empty Select.
export const BOOKING_STATUS_OPTIONS = [
    { value: 'pending', label: 'Pending' },
    { value: 'scheduled', label: 'Terjadwal' },
    { value: 'paid', label: 'Dibayar' },
    { value: 'shipped', label: 'Dikirim' },
    { value: 'completed', label: 'Selesai' },
    { value: 'cancelled', label: 'Batal' },
] as const;

export const BOOKING_STATUS_VALUES = [
    'pending',
    'scheduled',
    'paid',
    'shipped',
    'completed',
    'cancelled',
] as const;
export type BookingStatus = (typeof BOOKING_STATUS_VALUES)[number];

export const ORDER_TYPE_VALUES = ['service', 'product'] as const;
export type OrderType = (typeof ORDER_TYPE_VALUES)[number];

// --- Field cleaners ----------------------------------------------------------
function cleanText(v: unknown): unknown {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    return t === '' ? undefined : t;
}

function cleanEnum(v: unknown): unknown {
    const t = cleanText(v);
    return typeof t === 'string' ? t.toLowerCase() : t;
}

// Parse an Indonesian-formatted money string to whole rupiah. '.' is the
// thousands separator and ',' the decimal mark (id-ID); IDR has no sub-rupiah
// in practice, so any fraction is rounded. "Rp 75.000.000" → 75000000,
// "75.000.000,50" → 75000001, "75000000" → 75000000. Non-numeric → 0.
export function parseRupiah(input: string | number | null | undefined): number {
    if (input == null) return 0;
    if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : 0;
    const s = input.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n) : 0;
}

// Money preprocessor: interpret the thousands/decimal separators instead of
// concatenating every digit run (which would turn "75.000.000,50" into a number
// 100x too big).
function cleanMoney(v: unknown): unknown {
    if (v == null) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : parseRupiah(t);
}

// Count preprocessor: trim and pass through raw so z.coerce.number().int()
// rejects a fractional typo ("1.5") instead of flattening it to 15. Guest
// counts are entered without thousands separators.
function cleanCount(v: unknown): unknown {
    if (v == null) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
}

const optionalText = z.preprocess(cleanText, z.string().optional());
const optionalPhone = z.preprocess(
    cleanText,
    z
        .string()
        .refine((v) => normalizePhone(v) !== null, {
            error: 'Nomor HP tidak valid (contoh: 08123456789)',
        })
        .optional()
);
const moneyField = z.preprocess(
    cleanMoney,
    z.coerce.number({ error: 'Nominal harus angka' }).min(0, 'Nominal tidak boleh negatif').default(0)
);
const optionalCount = z.preprocess(
    cleanCount,
    z.coerce
        .number({ error: 'Jumlah tamu harus angka' })
        .int()
        .min(0)
        .max(1_000_000, 'Jumlah tamu tidak masuk akal')
        .optional()
);
const statusField = z.preprocess(cleanEnum, z.enum(BOOKING_STATUS_VALUES).default('pending'));
const orderTypeField = z.preprocess(cleanEnum, z.enum(ORDER_TYPE_VALUES).default('service'));

// --- The shared input schema -------------------------------------------------
export const bookingInputSchema = z.object({
    customer_name: z.preprocess(
        cleanText,
        z.string({ error: 'Nama pelanggan wajib diisi' }).min(1, 'Nama pelanggan wajib diisi')
    ),
    customer_phone: optionalPhone,
    event_type: optionalText,
    event_date: optionalText, // "YYYY-MM-DD" from a <input type="date">
    venue: optionalText,
    headcount: optionalCount,
    package: optionalText, // a one-line package description → stored as the single order item
    total_amount: moneyField,
    dp_amount: moneyField,
    status: statusField,
    order_type: orderTypeField,
    notes: optionalText, // stored in orders.delivery_info
});

export type BookingInput = z.infer<typeof bookingInputSchema>;

/** Remaining balance after the down-payment. */
export function remainingBalance(total: number, dp: number): number {
    return Math.max(0, (total || 0) - (dp || 0));
}

export function formatRupiah(n: number | null | undefined): string {
    return `Rp ${Number(n ?? 0).toLocaleString('id-ID')}`;
}
