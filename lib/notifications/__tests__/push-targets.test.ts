import { describe, it, expect, vi } from 'vitest';
import {
    filterSubscriptionsToMembers,
    isUndefinedColumn,
    parsePushSubscriptionBody,
} from '@/lib/notifications/push-targets';
import { settleWithin } from '@/lib/notifications/push';

const sub = (user_id: string, endpoint = `https://push.example/${user_id}`) => ({
    endpoint,
    p256dh: 'p',
    auth: 'a',
    user_id,
});

describe('filterSubscriptionsToMembers', () => {
    it("keeps only devices owned by current org members", () => {
        const subs = [sub('u1'), sub('u2'), sub('u1', 'https://push.example/u1-phone'), sub('gone')];
        expect(filterSubscriptionsToMembers(subs, ['u1', 'u2']).map((s) => s.endpoint)).toEqual([
            'https://push.example/u1',
            'https://push.example/u2',
            'https://push.example/u1-phone',
        ]);
    });

    it('sends to nobody when the org has no members', () => {
        expect(filterSubscriptionsToMembers([sub('u1')], [])).toEqual([]);
    });
});

describe('parsePushSubscriptionBody', () => {
    const valid = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'BPk', auth: 'xyz' },
    };

    it('accepts a browser PushSubscription JSON', () => {
        expect(parsePushSubscriptionBody(valid)).toEqual({
            endpoint: valid.endpoint,
            p256dh: 'BPk',
            auth: 'xyz',
        });
    });

    it('rejects missing fields, non-https endpoints and oversized values', () => {
        expect(parsePushSubscriptionBody(null)).toBeNull();
        expect(parsePushSubscriptionBody({ endpoint: valid.endpoint })).toBeNull();
        expect(parsePushSubscriptionBody({ ...valid, endpoint: 'http://push.example/x' })).toBeNull();
        expect(parsePushSubscriptionBody({ ...valid, endpoint: 'not a url' })).toBeNull();
        expect(
            parsePushSubscriptionBody({ ...valid, endpoint: `https://p.example/${'x'.repeat(3000)}` })
        ).toBeNull();
        expect(
            parsePushSubscriptionBody({ ...valid, keys: { p256dh: 'x'.repeat(300), auth: 'a' } })
        ).toBeNull();
    });
});

describe('settleWithin (logout push cleanup must never block)', () => {
    it('resolves as soon as the work finishes', async () => {
        await expect(settleWithin(Promise.resolve('done'), 10_000)).resolves.toBeUndefined();
    });

    it('swallows a rejection', async () => {
        await expect(settleWithin(Promise.reject(new Error('boom')), 10_000)).resolves.toBeUndefined();
    });

    it('gives up after the timeout when the work hangs', async () => {
        vi.useFakeTimers();
        try {
            let settled = false;
            const p = settleWithin(new Promise(() => {}), 2000).then(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(1999);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await p;
            expect(settled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('isUndefinedColumn', () => {
    // Drives the rollout-window fallback in sendPushToOrg (code shipped before
    // migration 0058 adds push_subscriptions.user_id).
    it('matches Postgres undefined_column only', () => {
        expect(isUndefinedColumn({ code: '42703' })).toBe(true);
        expect(isUndefinedColumn({ code: '42501' })).toBe(false);
        expect(isUndefinedColumn({ code: null })).toBe(false);
        expect(isUndefinedColumn(null)).toBe(false);
        expect(isUndefinedColumn(undefined)).toBe(false);
    });
});
