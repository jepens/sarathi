import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { redactPII } from '@/lib/utils/logger';

/**
 * WhatsApp Notification Module
 * Sends notifications to customers about order status changes
 */

interface Order {
    id: string;
    customer_name: string;
    customer_phone: string;
    items: Array<{
        name: string;
        qty: number;
        price?: number;
    }>;
    total_amount: number;
    delivery_info: string;
    order_type: 'product' | 'service';
}

/**
 * Send WhatsApp notification when payment is confirmed
 */
export async function sendPaymentNotification(order: Order): Promise<void> {
    try {
        // Format items list
        const itemsList = order.items
            .map(item => `• ${item.name} - ${item.qty} pcs`)
            .join('\n');

        // Create message
        const message = `✅ *Pembayaran Diterima!*

Terima kasih atas pembayaran Anda, ${order.customer_name || 'Kak'}! 🙏

📦 *Detail Pesanan:*
${itemsList}

💰 *Total: Rp ${order.total_amount.toLocaleString('id-ID')}*

📍 *Info Pengiriman:*
${order.delivery_info}

Pesanan Anda sedang diproses dan akan segera dikirim.

Terima kasih telah berbelanja! 😊`;

        // Send via WhatsApp
        await sendWhatsAppMessage(order.customer_phone, message);

        console.log(`Payment notification sent to ${redactPII(order.customer_phone)}`);
    } catch (error) {
        console.error('Error sending payment notification:', error);
        // Don't throw - notification failure shouldn't break order update
    }
}

/**
 * Send notification when order is cancelled
 */
export async function sendCancellationNotification(order: Order): Promise<void> {
    try {
        const message = `❌ *Pesanan Dibatalkan*

Halo ${order.customer_name || 'Kak'},

Pesanan Anda telah dibatalkan.

Jika Anda sudah melakukan pembayaran, dana akan dikembalikan dalam 1-3 hari kerja.

Jika ada pertanyaan, silakan hubungi kami. Terima kasih! 🙏`;

        await sendWhatsAppMessage(order.customer_phone, message);

        console.log(`Cancellation notification sent to ${redactPII(order.customer_phone)}`);
    } catch (error) {
        console.error('Error sending cancellation notification:', error);
    }
}
