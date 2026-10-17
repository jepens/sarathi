import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactForLog, redactPII, whatsappLogger } from '@/lib/utils/logger';

// Audit KEA-21 (UU PDP): customer identifiers never reach the container logs
// in plaintext. Fake numbers only.

afterEach(() => vi.restoreAllMocks());

// A wamid as Meta builds it: 'wamid.' + base64 of a struct that holds the
// customer's number in plain ASCII digits (here a fake one).
const fakeWamid = (number: string, tail = 'A1B2C3D4E5F6A7B8C9D0') =>
    `wamid.${Buffer.from(`\x18\x0c${number}\x15\x02\x00\x11\x18\x14${tail}\x00`, 'latin1').toString('base64')}`;

describe('redactPII', () => {
    it('masks every standalone run of 8+ digits, keeping the first 4 and the last 3', () => {
        expect(redactPII('628123456789')).toBe('6281*****789');
        expect(redactPII('from 6281234567890 and 6289876543210')).toBe('from 6281******890 and 6289******210');
        expect(redactPII('US.13491208655302741918')).toBe('US.1349*************918');
        expect(redactPII('12345678')).toBe('1234*678');
        expect(redactPII('{"from":"628123456789"}')).toBe('{"from":"6281*****789"}');
    });

    it('turns a wamid into a stable label without the number inside', () => {
        const a = fakeWamid('628123456789');
        const b = fakeWamid('628999888777');
        expect(Buffer.from(a.slice(6), 'base64').toString('latin1')).toContain('628123456789'); // the number really is inside
        const line = redactPII(`Status callback received: delivered for ${a}`);
        expect(line).toMatch(/^Status callback received: delivered for wamid#h[0-9a-f]{8}$/);
        expect(line).not.toContain(a.slice(6));
        expect(redactPII(a)).toBe(redactPII(a)); // the same message keeps its label
        expect(redactPII(a)).not.toBe(redactPII(b));
    });

    it('leaves uuids, hashes, short numbers, dates and counts alone', () => {
        const text = 'org 5a11e024-0001-4000-8000-000000000001, row 11111111-2222-3333-4444-555555555555, ' +
            'sha c24872ac81390000000012, 3 message(s), retry 2/5, 2026-10-17T03:00:00Z, 1234567';
        expect(redactPII(text)).toBe(text);
    });

    it('is idempotent', () => {
        const once = redactPII(`to 628123456789 ${fakeWamid('628123456789')}`);
        expect(redactPII(once)).toBe(once);
    });
});

describe('redactForLog', () => {
    it('redacts nested strings, PostgREST error details and Error causes', () => {
        const cause = new Error('connect to 628111222333 refused');
        const err = new Error('send failed', { cause });
        const out = redactForLog({
            details: 'Key (org_id, phone_number)=(5a11e024-0001-4000-8000-000000000001, 628123456789) already exists.',
            list: ['628999888777'],
            err,
        }) as Record<string, unknown>;
        const text = JSON.stringify(out);
        expect(text).not.toMatch(/628(111222333|123456789|999888777)/);
        expect(text).toContain('5a11e024-0001-4000-8000-000000000001');
        expect(((out.err as Record<string, unknown>).cause as { message: string }).message).toBe('connect to 6281*****333 refused');
    });
});

describe('Logger', () => {
    it('redacts the message and every string in the data', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        whatsappLogger.error('Conversation 628123456789 failed', { nested: { to: ['628999888777'] } });
        const [line, data] = log.mock.calls[0] as [string, Record<string, unknown>];
        expect(line).toContain('Conversation 6281*****789 failed');
        expect(JSON.stringify(data)).toContain('6289*****777');
    });

    it('logs a plain message without data as one argument', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        whatsappLogger.info('Rate limit exceeded for 628123456789');
        expect(log.mock.calls[0]).toHaveLength(1);
        expect(log.mock.calls[0][0]).toContain('6281*****789');
    });
});
