/**
 * Simple logging utility
 * Logs to console and optionally to file
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

// A WhatsApp message id: 'wamid.' + base64 of a struct that holds the
// customer's full number in plain digits, so masking digits never sees it.
const WAMID = /wamid\.[A-Za-z0-9+/=_-]+/g;
// 8+ digits standing alone: not part of a uuid ('5a11e024-0001-...'), a hash
// or another identifier made of letters, digits and dashes.
const LONG_DIGITS = /(?<![0-9A-Za-z-])\d{8,}(?![0-9A-Za-z-])/g;

/** FNV-1a (32 bit) as 8 hex digits: a stable, non-reversible label, the same in every log line. */
function shortHash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Masks customer identifiers in log text (audit KEA-21, UU PDP):
 * - a wamid becomes 'wamid#h<hash>': the same message keeps the same label
 *   across its sent / delivered / read lines, but the number inside is gone;
 * - a phone number or another long number id (wa_id, BSUID) keeps its first
 *   4 and last 3 digits (628123456789 -> 6281*****789), enough to tell two
 *   numbers apart.
 * Message text and request payloads are never logged at all; this catches the
 * identifiers in what is. Idempotent: redacting twice changes nothing.
 */
export function redactPII(text: string): string {
    return text
        .replace(WAMID, (id) => `wamid#h${shortHash(id)}`)
        .replace(LONG_DIGITS, (digits) => `${digits.slice(0, 4)}${'*'.repeat(digits.length - 7)}${digits.slice(-3)}`);
}

/**
 * redactPII applied to every string inside a logged value: nested objects,
 * arrays, PostgREST error objects (their `details` can name a phone number)
 * and Errors, including `cause`.
 */
export function redactForLog(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return redactPII(value);
    if (value === null || typeof value !== 'object' || depth > 5) return value;
    if (value instanceof Error) {
        const out: Record<string, unknown> = { name: value.name, message: redactPII(value.message) };
        if (value.stack) out.stack = redactPII(value.stack);
        for (const [k, v] of Object.entries(value)) out[k] = redactForLog(v, depth + 1);
        if (value.cause !== undefined) out.cause = redactForLog(value.cause, depth + 1);
        return out;
    }
    if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactForLog(v, depth + 1)]));
}

const redactValue = redactForLog;

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    data?: unknown;
}

class Logger {
    private serviceName: string;

    constructor(serviceName: string) {
        this.serviceName = serviceName;
    }

    private log(level: LogLevel, message: string, data?: unknown) {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message: `[${this.serviceName}] ${redactPII(message)}`,
            data: data === undefined ? undefined : redactValue(data)
        };

        // Console output with colors
        const colors = {
            info: '\x1b[36m',    // Cyan
            warn: '\x1b[33m',    // Yellow
            error: '\x1b[31m',   // Red
            debug: '\x1b[90m'    // Gray
        };
        const reset = '\x1b[0m';

        const logMessage = `${colors[level]}${entry.timestamp} [${level.toUpperCase()}] ${entry.message}${reset}`;

        if (entry.data) {
            console.log(logMessage, entry.data);
        } else {
            console.log(logMessage);
        }

        // In production, you could write to file or send to logging service
        // For now, console is sufficient
    }

    info(message: string, data?: unknown) {
        this.log('info', message, data);
    }

    warn(message: string, data?: unknown) {
        this.log('warn', message, data);
    }

    error(message: string, data?: unknown) {
        this.log('error', message, data);
    }

    debug(message: string, data?: unknown) {
        if (process.env.NODE_ENV === 'development') {
            this.log('debug', message, data);
        }
    }
}

// Export logger instances
export const whatsappLogger = new Logger('WhatsApp');
export const apiLogger = new Logger('API');
export const systemLogger = new Logger('System');
