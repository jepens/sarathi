import { describe, it, expect, vi, beforeEach } from 'vitest';

// The customer notifications of an order status change (paid, cancelled) go
// out from the credentials they are handed: the order's org's own number
// (Fase 2 task 2.2b, resolved in app/dashboard/orders/actions.ts). A failed
// send never fails the status change. Fake numbers and ids only.

vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn() }));

import { sendCancellationNotification, sendPaymentNotification } from '@/lib/notifications/notifications';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';

const CREDS = {
    orgId: 'aaaaaaaa-0000-4000-8000-00000000000a',
    integrationId: null,
    phoneNumberId: '100000000000001',
    wabaId: null,
    accessToken: 'token-palsu',
    graphVersion: 'v25.0',
};
const ORDER = {
    id: 'order-palsu-1',
    customer_name: 'Budi Palsu',
    customer_phone: '620000000001',
    items: [{ name: 'Paket Outing', qty: 2 }],
    total_amount: 1500000,
    delivery_info: 'Dikirim ke kantor',
    order_type: 'service' as const,
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendWhatsAppMessage).mockResolvedValue({ waMessageId: 'wamid.palsu', raw: {} });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('order notifications', () => {
    it('payment: sent to the customer with the credentials handed in', async () => {
        await sendPaymentNotification(CREDS, ORDER);
        expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
        const [creds, to, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
        expect(creds).toBe(CREDS);
        expect(to).toBe('620000000001');
        expect(text).toContain('Pembayaran Diterima');
        expect(text).toContain('Paket Outing - 2 pcs');
    });

    it('cancellation: sent to the customer with the credentials handed in', async () => {
        await sendCancellationNotification(CREDS, ORDER);
        expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
        const [creds, to, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
        expect(creds).toBe(CREDS);
        expect(to).toBe('620000000001');
        expect(text).toContain('Pesanan Dibatalkan');
    });

    it('a failed send is logged, never thrown (the status change already happened)', async () => {
        vi.mocked(sendWhatsAppMessage).mockRejectedValue(new Error('Meta WhatsApp 131047'));
        await expect(sendPaymentNotification(CREDS, ORDER)).resolves.toBeUndefined();
        await expect(sendCancellationNotification(CREDS, ORDER)).resolves.toBeUndefined();
    });
});
