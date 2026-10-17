// Runs once when the Next.js server starts.
export async function register() {
    // Customer identifiers never reach the container logs in plaintext (audit
    // KEA-21): every console.* call of the Node.js server is redacted.
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { installConsoleRedaction } = await import('./lib/utils/console-redaction');
        installConsoleRedaction();
    }
}
