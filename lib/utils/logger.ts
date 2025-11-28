/**
 * Simple logging utility
 * Logs to console and optionally to file
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

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
            message: `[${this.serviceName}] ${message}`,
            data
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

        if (data) {
            console.log(logMessage, data);
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
