import { describe, it, expect } from 'vitest';
import { isBookingStatus, planStatusSideEffects } from '@/lib/bookings/status-effects';

// Rules updateOrderStatus applies after a REAL status change (KEA-19). They
// mirror the pre-hotfix behaviour, except that a no-op transition no longer
// re-sends a WhatsApp notification.

describe('planStatusSideEffects', () => {
    it('payment: reduce stock + payment notification', () => {
        expect(planStatusSideEffects('pending', 'paid')).toEqual({
            reduceStock: true,
            returnStock: false,
            notify: 'payment',
        });
    });

    it('cancelling a paid/shipped order returns stock', () => {
        for (const old of ['paid', 'shipped']) {
            expect(planStatusSideEffects(old, 'cancelled')).toEqual({
                reduceStock: false,
                returnStock: true,
                notify: 'cancellation',
            });
        }
    });

    it('cancelling an unpaid order only notifies', () => {
        expect(planStatusSideEffects('pending', 'cancelled')).toEqual({
            reduceStock: false,
            returnStock: false,
            notify: 'cancellation',
        });
        expect(planStatusSideEffects(null, 'cancelled').notify).toBe('cancellation');
    });

    it('no-op transitions and other statuses do nothing', () => {
        const none = { reduceStock: false, returnStock: false, notify: null };
        expect(planStatusSideEffects('paid', 'paid')).toEqual(none);
        expect(planStatusSideEffects('cancelled', 'cancelled')).toEqual(none);
        expect(planStatusSideEffects('paid', 'shipped')).toEqual(none);
        expect(planStatusSideEffects('scheduled', 'completed')).toEqual(none);
    });
});

describe('isBookingStatus', () => {
    it('accepts the known statuses only', () => {
        expect(isBookingStatus('paid')).toBe(true);
        expect(isBookingStatus('scheduled')).toBe(true);
        expect(isBookingStatus('refunded')).toBe(false);
        expect(isBookingStatus(undefined)).toBe(false);
    });
});
