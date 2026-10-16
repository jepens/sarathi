/**
 * Simple logging utility
 * Logs to console and optionally to file
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Masks what looks like a phone number or another long number id (a wa_id,
 * a BSUID) in log text: every run of 8 or more digits keeps its first 4 and
 * last 3 digits (628123456789 -> 6281*****789), enough to tell two numbers
 * apart in the logs. Customer phone numbers must not sit in plaintext in the
 * container logs (audit KEA-21, UU PDP). Message text and request payloads
 * are never logged at all; this catches the numbers in what is.
 */
export function redactPII(text: string): string {
    return text.replace(/\d{8,}/g, (digits) => `${digits.slice(0, 4)}${'*'.repeat(digits.length - 7)}${digits.slice(-3)}`);
}

/** redactPII applied to every string inside a logged value (errors, PostgREST error objects, arrays). */
function redactValue(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return redactPII(value);
    if (value === null || typeof value !== 'object' || depth > 5) return value;
    if (value instanceof Error) {
        const out: Record<string, unknown> = { name: value.name, message: redactPII(value.message) };
        if (value.stack) out.stack = redactPII(value.stack);
        for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, depth + 1);
        return out;
    }
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, depth + 1)]));
}

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
