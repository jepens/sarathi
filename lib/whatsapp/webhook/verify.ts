// The webhook body as Meta signed it, read up to Meta's size limit (anyone
// can POST to the URL).

// Meta's largest webhook payload (developers.facebook.com, set-up-webhooks).
export const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;

// The request body, or null when it is over MAX_WEBHOOK_BYTES: by the declared
// length before reading, else while reading (a chunked body is cancelled as
// soon as it passes the limit).
export async function readBodyCapped(request: Request): Promise<Buffer | null> {
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
    if (!request.body) return Buffer.alloc(0);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_WEBHOOK_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
