/**
 * Server Actions for Order Status Updates
 * Handles stock operations and notifications server-side
 */

'use server';

import { createClient } from '@/lib/supabase/server';
import { reduceStock, returnStock } from '@/lib/inventory/stock';
import { sendPaymentNotification, sendCancellationNotification } from '@/lib/notifications/notifications';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { createOrFillLead } from '@/lib/leads/create';
import { normalizePhone } from '@/lib/leads/schema';
import {
    bookingInputSchema,
    remainingBalance,
    type BookingInput,
} from '@/lib/bookings/schema';

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

// ---------------------------------------------------------------------------
// Manual booking management (the "Bookings" UI). A booking is an `orders` row,
// event-focused. Status transitions still go through updateOrderStatus above
// (which carries the stock + WhatsApp side-effects); these actions only manage
// the booking's data fields and payment tracking.
// ---------------------------------------------------------------------------

type ActionResult = { success: boolean; message: string; id?: string };

// orders.event_date is timestamptz; the calendar (/api/events) renders it as a
// Jakarta-local date. Store the chosen YYYY-MM-DD as noon WIB so it never slips
// across the midnight boundary in any timezone conversion.
function eventDateToIso(date: string | undefined): string | null {
    return date ? `${date}T12:00:00+07:00` : null;
}

// A booking carries a single descriptive line item (package or event type) so
// the existing order list + total render sensibly.
function packageItems(input: BookingInput): { name: string; qty: number; price: number }[] {
    const name = input.package || input.event_type;
    return name ? [{ name, qty: 1, price: input.total_amount }] : [];
}

function commonOrderFields(input: BookingInput, customerPhone: string | null) {
    return {
        customer_name: input.customer_name,
        customer_phone: customerPhone,
        total_amount: input.total_amount,
        dp_amount: input.dp_amount,
        status: input.status,
        order_type: input.order_type,
        delivery_info: input.notes ?? null,
        event_type: input.event_type ?? null,
        venue: input.venue ?? null,
        headcount: input.headcount ?? null,
        event_date: eventDateToIso(input.event_date),
    };
}

// Ensure the customer phone exists as a contact so the FK
// orders.(org_id, customer_phone) -> whatsapp_chats is satisfied. Returns the
// normalized phone to store, or null when no/invalid phone was given.
async function ensureCustomerContact(
    supabase: Awaited<ReturnType<typeof createClient>>,
    orgId: string,
    input: BookingInput
): Promise<string | null> {
    const realPhone = normalizePhone(input.customer_phone ?? null);
    if (!realPhone) return null;
    // Any result is fine — we just need the whatsapp_chats row to exist.
    await createOrFillLead(supabase, orgId, {
        contact_name: input.customer_name,
        phone_number: input.customer_phone,
        event_interest: input.event_type,
        location_pref: input.venue,
        participant_count: input.headcount,
        source: 'manual',
        lead_stage: 'won',
    });
    return realPhone;
}

export async function createBooking(raw: unknown): Promise<ActionResult> {
    const parsed = bookingInputSchema.safeParse(raw);
    if (!parsed.success) {
        return { success: false, message: parsed.error.issues[0]?.message ?? 'Data tidak valid' };
    }
    const input = parsed.data;
    try {
        const supabase = await createClient();
        const orgId = await getCurrentOrgId(supabase);
        if (!orgId) return { success: false, message: 'Tidak ada organisasi aktif untuk akun ini' };

        const customerPhone = await ensureCustomerContact(supabase, orgId, input);

        const { data, error } = await supabase
            .from('orders')
            .insert({
                org_id: orgId,
                ...commonOrderFields(input, customerPhone),
                items: packageItems(input),
            })
            .select('id')
            .single();
        if (error) return { success: false, message: error.message };
        return { success: true, message: 'Booking dibuat', id: data?.id };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Gagal membuat booking',
        };
    }
}

export async function updateBooking(id: string, raw: unknown): Promise<ActionResult> {
    const parsed = bookingInputSchema.safeParse(raw);
    if (!parsed.success) {
        return { success: false, message: parsed.error.issues[0]?.message ?? 'Data tidak valid' };
    }
    const input = parsed.data;
    try {
        const supabase = await createClient();
        const orgId = await getCurrentOrgId(supabase);
        if (!orgId) return { success: false, message: 'Tidak ada organisasi aktif untuk akun ini' };

        const customerPhone = await ensureCustomerContact(supabase, orgId, input);

        const patch: Record<string, unknown> = {
            ...commonOrderFields(input, customerPhone),
            updated_at: new Date().toISOString(),
        };
        // Refresh the single package line only when a package was given AND this
        // isn't a genuine multi-line (AI-created product) order — otherwise the
        // edit would collapse real per-item lines/prices into one synthetic line.
        if (input.package) {
            const { data: existing } = await supabase
                .from('orders')
                .select('items')
                .eq('id', id)
                .single();
            const existingItems = Array.isArray(existing?.items) ? existing.items : [];
            if (existingItems.length <= 1) patch.items = packageItems(input);
        }

        const { error } = await supabase.from('orders').update(patch).eq('id', id);
        if (error) return { success: false, message: error.message };
        return { success: true, message: 'Booking diperbarui' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Gagal memperbarui booking',
        };
    }
}

export async function deleteBooking(id: string): Promise<ActionResult> {
    try {
        const supabase = await createClient();
        const orgId = await getCurrentOrgId(supabase);
        if (!orgId) return { success: false, message: 'Tidak ada organisasi aktif untuk akun ini' };

        const { error } = await supabase.from('orders').delete().eq('id', id);
        if (error) return { success: false, message: error.message };
        return { success: true, message: 'Booking dihapus' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Gagal menghapus booking',
        };
    }
}

export async function setDpPaid(id: string, paid: boolean): Promise<ActionResult> {
    try {
        const supabase = await createClient();
        const orgId = await getCurrentOrgId(supabase);
        if (!orgId) return { success: false, message: 'Tidak ada organisasi aktif untuk akun ini' };

        const { error } = await supabase
            .from('orders')
            .update({
                dp_paid_at: paid ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', id);
        if (error) return { success: false, message: error.message };
        return { success: true, message: paid ? 'DP ditandai dibayar' : 'Tanda DP dibatalkan' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Gagal memperbarui DP',
        };
    }
}

export async function setSettled(id: string, paid: boolean): Promise<ActionResult> {
    try {
        const supabase = await createClient();
        const orgId = await getCurrentOrgId(supabase);
        if (!orgId) return { success: false, message: 'Tidak ada organisasi aktif untuk akun ini' };

        const patch: Record<string, unknown> = {
            pelunasan_paid_at: paid ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
        };
        if (paid) {
            const { data } = await supabase
                .from('orders')
                .select('total_amount, dp_amount')
                .eq('id', id)
                .single();
            if (data) {
                patch.pelunasan_amount = remainingBalance(
                    Number(data.total_amount),
                    Number(data.dp_amount)
                );
            }
        }
        const { error } = await supabase.from('orders').update(patch).eq('id', id);
        if (error) return { success: false, message: error.message };
        return { success: true, message: paid ? 'Booking ditandai lunas' : 'Tanda lunas dibatalkan' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Gagal memperbarui pelunasan',
        };
    }
}
