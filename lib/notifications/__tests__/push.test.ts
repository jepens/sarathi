import { describe, it, expect } from 'vitest';
import { urlBase64ToUint8Array } from '@/lib/notifications/push';

// urlBase64ToUint8Array turns the URL-safe base64 VAPID public key into the
// Uint8Array PushManager.subscribe() needs. Getting the URL-safe alphabet or the
// padding wrong yields a key the push service silently rejects, so pin it down.

describe('urlBase64ToUint8Array', () => {
    it('round-trips arbitrary bytes encoded as URL-safe base64 (unpadded)', () => {
        const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37 + 11) % 256);
        // Node base64url is URL-safe AND unpadded — exactly the VAPID key shape.
        const b64url = Buffer.from(bytes).toString('base64url');
        expect(Array.from(urlBase64ToUint8Array(b64url))).toEqual(Array.from(bytes));
    });

    it('decodes the URL-safe chars (- and _) that standard base64 spells + and /', () => {
        // 0xFB 0xFF → standard base64 "+/8=", URL-safe + unpadded "-_8".
        expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([0xfb, 0xff]);
    });

    it('produces the 65-byte length of a real P-256 VAPID public key', () => {
        const key = new Uint8Array(65);
        key[0] = 0x04; // uncompressed point marker
        const b64url = Buffer.from(key).toString('base64url');
        expect(urlBase64ToUint8Array(b64url).length).toBe(65);
    });
});
