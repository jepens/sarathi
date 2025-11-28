import crypto from 'crypto';

/**
 * Verify WhatsApp webhook signature
 * @param payload - Raw request body as string
 * @param signature - X-Hub-Signature-256 header value
 * @returns boolean - true if signature is valid
 */
export function verifyWhatsAppSignature(payload: string, signature: string | null): boolean {
    if (!signature) {
        console.warn('No signature provided');
        return false;
    }

    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
        console.warn('WHATSAPP_APP_SECRET not configured');
        return false; // In development, you might want to return true
    }

    try {
        // Remove 'sha256=' prefix if present
        const signatureHash = signature.startsWith('sha256=')
            ? signature.slice(7)
            : signature;

        // Calculate expected signature
        const expectedHash = crypto
            .createHmac('sha256', appSecret)
            .update(payload)
            .digest('hex');

        // Constant-time comparison to prevent timing attacks
        return crypto.timingSafeEqual(
            Buffer.from(signatureHash, 'hex'),
            Buffer.from(expectedHash, 'hex')
        );
    } catch (error) {
        console.error('Error verifying signature:', error);
        return false;
    }
}
