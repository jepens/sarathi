import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactPII, whatsappLogger } from '@/lib/utils/logger';

// Audit KEA-21 (UU PDP): customer phone numbers never reach the container logs
// in plaintext. Fake numbers only.

afterEach(() => vi.restoreAllMocks());

describe('redactPII', () => {
    it('masks every run of 8+ digits, keeping the first 4 and the last 3', () => {
        expect(redactPII('628123456789')).toBe('6281*****789');
        expect(redactPII('from 6281234567890 and 6289876543210')).toBe('from 6281******890 and 6289******210');
        expect(redactPII('US.13491208655302741918')).toBe('US.1349*************918');
        expect(redactPII('12345678')).toBe('1234*678');
    });

    it('leaves short numbers, dates and counts alone', () => {
        expect(redactPII('3 message(s), retry 2/5, 2026-10-17T03:00:00Z, 1234567')).toBe(
            '3 message(s), retry 2/5, 2026-10-17T03:00:00Z, 1234567'
        );
    });
});

describe('Logger', () => {
    it('redacts the message and every string in the data, nested and in errors', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = new Error('send to 628111222333 failed');
        whatsappLogger.error('Conversation 628123456789 failed', {
            detail: 'Key (phone_number)=(628123456789) already exists',
            nested: { to: ['628999888777'] },
            err,
        });
        const [line, data] = log.mock.calls[0] as [string, Record<string, unknown>];
        expect(line).toContain('Conversation 6281*****789 failed');
        const text = JSON.stringify(data);
        expect(text).not.toMatch(/\d{8,}/);
        expect(text).toContain('6281*****789');
        expect(text).toContain('6289*****777');
        expect((data.err as { message: string }).message).toBe('send to 6281*****333 failed');
    });

    it('logs a plain message without data as one argument', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        whatsappLogger.info('Rate limit exceeded for 628123456789');
        expect(log.mock.calls[0]).toHaveLength(1);
        expect(log.mock.calls[0][0]).toContain('6281*****789');
    });
});
