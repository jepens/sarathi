import { redactForLog, redactPII } from '@/lib/utils/logger';

// Audit KEA-21 (UU PDP): server code logs through console.* in hundreds of
// places, and error objects (PostgREST `details`, Meta and OpenAI errors) can
// carry a customer's phone number or a wamid. Instead of trusting every call
// site, the server routes all console output through redactPII once at
// startup (instrumentation.ts). Lines that already went through the logger
// come out the same: redaction is idempotent.

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const INSTALLED = Symbol.for('sarathi.consoleRedaction');

type ConsoleLike = Pick<Console, (typeof METHODS)[number]>;

/**
 * A copy of an Error with every string property redacted (message, stack,
 * code, details ...) and the same prototype, so console still prints it as
 * that error class with its stack.
 */
export function redactError(error: Error): Error {
    const copy = Object.create(Object.getPrototypeOf(error)) as Error;
    for (const key of Object.getOwnPropertyNames(error)) {
        const value: unknown = (error as unknown as Record<string, unknown>)[key];
        Object.defineProperty(copy, key, {
            value: typeof value === 'string' ? redactPII(value) : redactForLog(value),
            enumerable: Object.prototype.propertyIsEnumerable.call(error, key),
            writable: true,
            configurable: true,
        });
    }
    return copy;
}

function redactArg(arg: unknown): unknown {
    if (typeof arg === 'string') return redactPII(arg);
    if (arg instanceof Error) return redactError(arg);
    return redactForLog(arg);
}

/** Wraps console.log/info/warn/error/debug so every argument is redacted. Safe to call twice. */
export function installConsoleRedaction(target: ConsoleLike = console): void {
    const flagged = target as ConsoleLike & { [INSTALLED]?: boolean };
    if (flagged[INSTALLED]) return;
    for (const method of METHODS) {
        const original = target[method].bind(target);
        target[method] = (...args: unknown[]) => original(...args.map(redactArg));
    }
    flagged[INSTALLED] = true;
}
