import { BOOKING_STATUS_VALUES, type BookingStatus } from '@/lib/bookings/schema';

// Side effects of an order status transition, decided purely from the OLD
// status (read from the DB, never from the client) and the NEW status. Used by
// updateOrderStatus (app/dashboard/orders/actions.ts) — kept pure so the rules
// are unit-testable.
//
//   → paid (from anything but paid): reduce stock + "Pembayaran Diterima" WA
//   → cancelled (from anything but cancelled): "Pesanan Dibatalkan" WA, and
//     return stock if the order had been paid/shipped
//   no-op transitions (old === new) never trigger anything.

export interface StatusSideEffects {
    reduceStock: boolean;
    returnStock: boolean;
    notify: 'payment' | 'cancellation' | null;
}

const NONE: StatusSideEffects = { reduceStock: false, returnStock: false, notify: null };

export function isBookingStatus(value: unknown): value is BookingStatus {
    return typeof value === 'string' && (BOOKING_STATUS_VALUES as readonly string[]).includes(value);
}

export function planStatusSideEffects(
    oldStatus: string | null,
    newStatus: string,
): StatusSideEffects {
    if (oldStatus === newStatus) return NONE;
    if (newStatus === 'paid') {
        return { reduceStock: true, returnStock: false, notify: 'payment' };
    }
    if (newStatus === 'cancelled') {
        return {
            reduceStock: false,
            returnStock: oldStatus === 'paid' || oldStatus === 'shipped',
            notify: 'cancellation',
        };
    }
    return NONE;
}
