/**
 * Server Actions for Order Status Updates
 * Handles stock operations and notifications server-side
 */

'use server';

import { createClient } from '@/lib/supabase/server';
import { reduceStock, returnStock } from '@/lib/inventory/stock';
import { sendPaymentNotification, sendCancellationNotification } from '@/lib/notifications/notifications';

interface OrderItem {
    product_id?: string;
    name: string;
    qty: number;
    price?: number;
}

interface Order {
    id: string;
    customer_name: string;
    customer_phone: string;
    items: OrderItem[];
    total_amount: number;
    delivery_info: string;
    order_type: 'product' | 'service';
    status: string;
}

export async function updateOrderStatus(
    orderId: string,
    newStatus: string,
    currentOrder: Order
): Promise<{ success: boolean; message: string }> {
    try {
        const supabase = await createClient();
        const oldStatus = currentOrder.status;

        // Update status in database
        const { error } = await supabase
            .from('orders')
            .update({ status: newStatus })
            .eq('id', orderId);

        if (error) {
            return { success: false, message: 'Gagal mengupdate status' };
        }

        let message = `Status diubah menjadi ${newStatus}`;

        // Handle stock operations based on status transition
        if (newStatus === 'paid' && oldStatus !== 'paid') {
            // Reduce stock when payment is confirmed
            const stockResult = await reduceStock(currentOrder.items);

            if (stockResult.success) {
                message = 'Status diubah menjadi paid & stok dikurangi';
            } else {
                message = 'Status diubah menjadi paid (warning: gagal mengurangi stok)';
                console.error('Stock reduction failed:', stockResult.error);
            }

            // Send WhatsApp notification
            await sendPaymentNotification(currentOrder);
        } else if (newStatus === 'cancelled') {
            // Return stock if order was previously paid
            if (oldStatus === 'paid' || oldStatus === 'shipped') {
                const stockResult = await returnStock(currentOrder.items);

                if (stockResult.success) {
                    message = 'Pesanan dibatalkan & stok dikembalikan';
                } else {
                    message = 'Pesanan dibatalkan (warning: gagal mengembalikan stok)';
                    console.error('Stock return failed:', stockResult.error);
                }
            } else {
                message = 'Pesanan dibatalkan';
            }

            // Send cancellation notification
            await sendCancellationNotification(currentOrder);
        }

        return { success: true, message };
    } catch (error) {
        console.error('Error in updateOrderStatus:', error);
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Terjadi kesalahan'
        };
    }
}
