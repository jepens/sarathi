import { describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction, redactError } from '@/lib/utils/console-redaction';

// Every console.* call of the server goes through redactPII (instrumentation.ts,
// audit KEA-21). Fake numbers only.

function fakeConsole() {
    return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('installConsoleRedaction', () => {
    it('redacts strings, objects and errors passed to every method', () => {
        const target = fakeConsole();
        const original = { ...target };
        installConsoleRedaction(target);
        target.log('Order created for 628123456789');
        target.error('Error creating order:', { details: 'Key (phone_number)=(628123456789) already exists.' });
        target.warn(new TypeError('fetch to 628111222333 failed'));
        expect(original.log).toHaveBeenCalledWith('Order created for 6281*****789');
        expect(JSON.stringify(original.error.mock.calls[0])).not.toContain('628123456789');
        const err = original.warn.mock.calls[0][0] as Error;
        expect(err).toBeInstanceOf(TypeError); // still printed as that error class
        expect(err.message).toBe('fetch to 6281*****333 failed');
        expect(err.stack ?? '').not.toContain('628111222333');
    });

    it('installs once', () => {
        const target = fakeConsole();
        const original = target.log;
        installConsoleRedaction(target);
        const wrapped = target.log;
        installConsoleRedaction(target);
        expect(target.log).toBe(wrapped);
        target.log('x');
        expect(original).toHaveBeenCalledTimes(1);
    });
});

describe('redactError', () => {
    it('keeps the prototype and redacts own string fields, cause included', () => {
        const err = new Error('to 628123456789', { cause: new Error('628999888777 unreachable') });
        (err as Error & { code?: string }).code = 'E 628123456789';
        const copy = redactError(err);
        expect(copy).toBeInstanceOf(Error);
        expect(copy.message).toBe('to 6281*****789');
        expect((copy as Error & { code?: string }).code).toBe('E 6281*****789');
        expect((copy.cause as { message: string }).message).toBe('6289*****777 unreachable');
        expect(Object.keys(copy)).toEqual(Object.keys(err)); // enumerability kept
    });
});
