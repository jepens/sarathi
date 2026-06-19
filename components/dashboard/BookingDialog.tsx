'use client';

import { useEffect, useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
    bookingInputSchema,
    remainingBalance,
    formatRupiah,
    parseRupiah,
    BOOKING_STATUS_OPTIONS,
    BOOKING_STATUS_VALUES,
    ORDER_TYPE_VALUES,
    type BookingStatus,
    type OrderType,
} from '@/lib/bookings/schema';
import { createBooking, updateBooking } from '@/app/dashboard/orders/actions';

export interface BookingEditData {
    id: string;
    customer_name: string | null;
    customer_phone: string | null;
    event_type: string | null;
    event_date: string | null; // ISO timestamptz
    venue: string | null;
    headcount: number | null;
    total_amount: number | null;
    dp_amount: number | null;
    status: string | null;
    order_type: string | null;
    delivery_info: string | null;
    items: { name: string; qty: number; price: number }[] | null;
}

// Prefill for "Jadikan Booking" from a won lead (create mode, no id).
export interface BookingPrefill {
    customer_name?: string | null;
    customer_phone?: string | null;
    event_type?: string | null;
    venue?: string | null;
    headcount?: number | null;
    notes?: string | null;
}

interface BookingFormState {
    customer_name: string;
    customer_phone: string;
    event_type: string;
    event_date: string; // YYYY-MM-DD
    venue: string;
    headcount: string;
    package: string;
    total_amount: string;
    dp_amount: string;
    status: BookingStatus;
    order_type: OrderType;
    notes: string;
}

const EMPTY_FORM: BookingFormState = {
    customer_name: '',
    customer_phone: '',
    event_type: '',
    event_date: '',
    venue: '',
    headcount: '',
    package: '',
    total_amount: '',
    dp_amount: '',
    status: 'pending',
    order_type: 'service',
    notes: '',
};

function asStatus(s: string | null | undefined): BookingStatus {
    return s != null && (BOOKING_STATUS_VALUES as readonly string[]).includes(s)
        ? (s as BookingStatus)
        : 'pending';
}
function asOrderType(s: string | null | undefined): OrderType {
    return s === 'product' || s === 'service' ? s : 'service';
}
// Convert a stored timestamptz to the YYYY-MM-DD a <input type="date"> expects,
// as observed in Asia/Jakarta (matches how the calendar renders the date).
function isoToDateInput(iso: string | null): string {
    if (!iso) return '';
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(new Date(iso));
        const y = parts.find((p) => p.type === 'year')?.value;
        const m = parts.find((p) => p.type === 'month')?.value;
        const d = parts.find((p) => p.type === 'day')?.value;
        return y && m && d ? `${y}-${m}-${d}` : '';
    } catch {
        return '';
    }
}

interface BookingDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
    bookingToEdit?: BookingEditData | null;
    prefill?: BookingPrefill | null;
}

export function BookingDialog({
    open,
    onOpenChange,
    onSuccess,
    bookingToEdit,
    prefill,
}: BookingDialogProps) {
    const isEdit = !!bookingToEdit;
    const [loading, setLoading] = useState(false);
    const [form, setForm] = useState<BookingFormState>(EMPTY_FORM);
    const [errors, setErrors] = useState<Record<string, string>>({});

    // Prefill on (re)open: from the booking (edit), from a lead (create+prefill),
    // or blank.
    useEffect(() => {
        if (bookingToEdit) {
            const firstItem = bookingToEdit.items?.[0];
            setForm({
                customer_name: bookingToEdit.customer_name ?? '',
                customer_phone: bookingToEdit.customer_phone ?? '',
                event_type: bookingToEdit.event_type ?? '',
                event_date: isoToDateInput(bookingToEdit.event_date),
                venue: bookingToEdit.venue ?? '',
                headcount: bookingToEdit.headcount != null ? String(bookingToEdit.headcount) : '',
                package: firstItem?.name ?? '',
                total_amount:
                    bookingToEdit.total_amount != null ? String(bookingToEdit.total_amount) : '',
                dp_amount: bookingToEdit.dp_amount != null ? String(bookingToEdit.dp_amount) : '',
                status: asStatus(bookingToEdit.status),
                order_type: asOrderType(bookingToEdit.order_type),
                notes: bookingToEdit.delivery_info ?? '',
            });
        } else if (prefill) {
            setForm({
                ...EMPTY_FORM,
                customer_name: prefill.customer_name ?? '',
                customer_phone: prefill.customer_phone ?? '',
                event_type: prefill.event_type ?? '',
                venue: prefill.venue ?? '',
                headcount: prefill.headcount != null ? String(prefill.headcount) : '',
                notes: prefill.notes ?? '',
            });
        } else {
            setForm(EMPTY_FORM);
        }
        setErrors({});
    }, [bookingToEdit, prefill, open]);

    const set = <K extends keyof BookingFormState>(key: K, value: BookingFormState[K]) =>
        setForm((f) => ({ ...f, [key]: value }));

    const remaining = remainingBalance(parseRupiah(form.total_amount), parseRupiah(form.dp_amount));

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const parsed = bookingInputSchema.safeParse(form);
        if (!parsed.success) {
            const fieldErrors: Record<string, string> = {};
            for (const issue of parsed.error.issues) {
                const key = String(issue.path[0] ?? '');
                if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
            }
            setErrors(fieldErrors);
            toast.error(parsed.error.issues[0]?.message ?? 'Periksa kembali isian form');
            return;
        }
        setErrors({});
        setLoading(true);
        try {
            const result = bookingToEdit
                ? await updateBooking(bookingToEdit.id, form)
                : await createBooking(form);
            if (!result.success) {
                toast.error(result.message);
                return;
            }
            toast.success(result.message);
            onSuccess();
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Gagal menyimpan booking');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px] max-h-[90dvh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Edit Booking' : 'Buat Booking'}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="customer_name">Nama pelanggan *</Label>
                            <Input
                                id="customer_name"
                                value={form.customer_name}
                                onChange={(e) => set('customer_name', e.target.value)}
                                placeholder="Budi Santoso"
                            />
                            {errors.customer_name && (
                                <p className="text-xs text-destructive">{errors.customer_name}</p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="customer_phone">Nomor HP (opsional)</Label>
                            <Input
                                id="customer_phone"
                                value={form.customer_phone}
                                onChange={(e) => set('customer_phone', e.target.value)}
                                placeholder="08123456789"
                                inputMode="tel"
                            />
                            {errors.customer_phone && (
                                <p className="text-xs text-destructive">{errors.customer_phone}</p>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="event_type">Jenis acara</Label>
                            <Input
                                id="event_type"
                                value={form.event_type}
                                onChange={(e) => set('event_type', e.target.value)}
                                placeholder="Pernikahan, gathering, dll."
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="event_date">Tanggal acara</Label>
                            <Input
                                id="event_date"
                                type="date"
                                value={form.event_date}
                                onChange={(e) => set('event_date', e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="venue">Lokasi / venue</Label>
                            <Input
                                id="venue"
                                value={form.venue}
                                onChange={(e) => set('venue', e.target.value)}
                                placeholder="Gedung A, Bandung"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="headcount">Jumlah tamu (pax)</Label>
                            <Input
                                id="headcount"
                                value={form.headcount}
                                onChange={(e) => set('headcount', e.target.value)}
                                placeholder="300"
                                inputMode="numeric"
                            />
                            {errors.headcount && (
                                <p className="text-xs text-destructive">{errors.headcount}</p>
                            )}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="package">Paket / deskripsi</Label>
                        <Input
                            id="package"
                            value={form.package}
                            onChange={(e) => set('package', e.target.value)}
                            placeholder="Paket Gold — 2 sesi, dekor, catering, MC, dokumentasi"
                        />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="total_amount">Total harga (Rp)</Label>
                            <Input
                                id="total_amount"
                                value={form.total_amount}
                                onChange={(e) => set('total_amount', e.target.value)}
                                placeholder="75.000.000"
                                inputMode="numeric"
                            />
                            {errors.total_amount && (
                                <p className="text-xs text-destructive">{errors.total_amount}</p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="dp_amount">DP / uang muka (Rp)</Label>
                            <Input
                                id="dp_amount"
                                value={form.dp_amount}
                                onChange={(e) => set('dp_amount', e.target.value)}
                                placeholder="25.000.000"
                                inputMode="numeric"
                            />
                            <p className="text-[11px] text-muted-foreground">
                                Sisa: {formatRupiah(remaining)}
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="status">Status</Label>
                            <Select
                                value={form.status}
                                onValueChange={(v) => set('status', v as BookingStatus)}
                            >
                                <SelectTrigger id="status">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {BOOKING_STATUS_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="order_type">Tipe</Label>
                            <Select
                                value={form.order_type}
                                onValueChange={(v) => set('order_type', v as OrderType)}
                            >
                                <SelectTrigger id="order_type">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {ORDER_TYPE_VALUES.map((v) => (
                                        <SelectItem key={v} value={v}>
                                            {v === 'service' ? 'Jasa / Event' : 'Produk'}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="notes">Catatan</Label>
                        <Textarea
                            id="notes"
                            value={form.notes}
                            onChange={(e) => set('notes', e.target.value)}
                            placeholder="Catatan internal, detail tambahan, dll."
                            rows={3}
                        />
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={loading}
                        >
                            Batal
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Simpan
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
