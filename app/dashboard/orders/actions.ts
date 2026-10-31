/**
 * Server Actions for Order Status Updates
 * Handles stock operations and notifications server-side
 */

'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { reduceStock, returnStock } from '@/lib/inventory/stock';
import { sendPaymentNotification, sendCancellationNotification } from '@/lib/notifications/notifications';
import { requireOrgContext } from '@/lib/settings/org-context';
import { getOrgWhatsAppCreds, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/credentials';
import { resolveSendTarget } from '@/lib/whatsapp/recipient';
import { isBookingStatus, planStatusSideEffects } from '@/lib/bookings/status-effects';
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

// The order row as the status transition reads it from the DB (nullable
// columns included — normalised before the notification helpers see them).
interface OrderRow {
    id: string;
    status: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    items: OrderItem[] | null;
    total_amount: number | null;
    delivery_info: string | null;
    order_type: 'product' | 'service' | null;
}

const STATUS_ORDER_SELECT =
    'id, status, customer_name, customer_phone, items, total_amount, delivery_info, order_type';

/**
 * The credentials of the org's own WhatsApp number for a customer
 * notification, or null: an org without one (WhatsAppNotConfiguredError) or
 * credentials that cannot be read right now (logged) send nothing. The status
 * change itself has already succeeded.
 */
async function orderNotifyCreds(orgId: string): Promise<WaCreds | null> {
    try {
        return await getOrgWhatsAppCreds(orgId);
    } catch (error) {
        if (!(error instanceof WhatsAppNotConfiguredError)) {
            console.error('Order notification skipped: WhatsApp credentials could not be read', error);
        }
        return null;
    }
}

/**
 * Change an order's status and run the transition's side effects (stock +
 * customer WhatsApp). Hardened (KEA-19):
 *   - requires a signed-in org member;
 *   - loads the order from the DB (RLS + explicit org filter) — the client no
 *     longer supplies the order object, so it can't forge the name/items/total
 *     /phone that end up in a WhatsApp message;
 *   - compare-and-set on the status it read, and side effects run only when
 *     that update really changed a row (no phantom notifications for a
 *     foreign/unknown id, and no double send on concurrent clicks);
 *   - WhatsApp notifications only from the org's own number (Fase 2 task
 *     2.2b; today the default org's env credentials).
 */
export async function updateOrderStatus(
    orderId: string,
    newStatus: string
): Promise<{ success: boolean; message: string }> {
    try {
        if (typeof orderId !== 'string' || !orderId) {
            return { success: false, message: 'Order tidak valid' };
        }
        if (!isBookingStatus(newStatus)) {
            return { success: false, message: 'Status tidak valid' };
        }

        // Strict session check (Auth-server round trip, not the local JWT
        // check): a status change can send customer WhatsApp messages through
        // the env credentials, so a signed-out / banned user must be refused
        // before their JWT expires — same rule as requireEnvIntegration.
        const access = await requireOrgContext({ strict: true });
        if (!access.ok) return { success: false, message: access.error };
        const { supabase, orgId } = access;

        const { data, error: loadError } = await supabase
            .from('orders')
            .select(STATUS_ORDER_SELECT)
            .eq('id', orderId)
            .eq('org_id', orgId)
            .maybeSingle();
        if (loadError) {
            return { success: false, message: 'Gagal memuat order' };
        }
        if (!data) {
            return { success: false, message: 'Order tidak ditemukan' };
        }
        const order = data as unknown as OrderRow;
        const oldStatus = order.status;

        if (oldStatus === newStatus) {
            return { success: true, message: `Status sudah ${newStatus}` };
        }

        // Compare-and-set: only flip the row if it still has the status we
        // read, so concurrent clicks can't both run the side effects.
        let update = supabase
            .from('orders')
            .update({ status: newStatus })
            .eq('id', orderId)
            .eq('org_id', orgId);
        update = oldStatus === null ? update.is('status', null) : update.eq('status', oldStatus);
        const { data: updated, error } = await update.select('id');

        if (error) {
            return { success: false, message: 'Gagal mengupdate status' };
        }
        if (!updated || updated.length === 0) {
            return {
                success: false,
                message: 'Status order sudah berubah. Muat ulang halaman lalu coba lagi.',
            };
        }

        const effects = planStatusSideEffects(oldStatus, newStatus);
        const items = Array.isArray(order.items) ? order.items : [];
        let message = `Status diubah menjadi ${newStatus}`;

        // Handle stock operations based on status transition
        if (effects.reduceStock) {
            // Reduce stock when payment is confirmed
            const stockResult = await reduceStock(items);

            if (stockResult.success) {
                message = 'Status diubah menjadi paid & stok dikurangi';
            } else {
                message = 'Status diubah menjadi paid (warning: gagal mengurangi stok)';
                console.error('Stock reduction failed:', stockResult.error);
            }
        } else if (effects.returnStock) {
            // Return stock if order was previously paid
            const stockResult = await returnStock(items);

            if (stockResult.success) {
                message = 'Pesanan dibatalkan & stok dikembalikan';
            } else {
                message = 'Pesanan dibatalkan (warning: gagal mengembalikan stok)';
                console.error('Stock return failed:', stockResult.error);
            }
        } else if (newStatus === 'cancelled') {
            message = 'Pesanan dibatalkan';
        }

        // Customer WhatsApp goes out from the org's own number only (Fase 2
        // task 2.2b), built from the DB row; an org without one sends nothing.
        // A phone-hidden customer (a BSUID key) is sent to its recovered phone
        // when there is one, as the AI replies are.
        const notifyCreds = effects.notify && order.customer_phone ? await orderNotifyCreds(orgId) : null;
        if (effects.notify && order.customer_phone && notifyCreds) {
            const notifyOrder = {
                id: order.id,
                customer_name: order.customer_name ?? '',
                customer_phone: await resolveSendTarget(supabase, orgId, order.customer_phone),
                items,
                total_amount: Number(order.total_amount ?? 0),
                delivery_info: order.delivery_info ?? '',
                order_type: order.order_type ?? 'service',
            };
            if (effects.notify === 'payment') {
                await sendPaymentNotification(notifyCreds, notifyOrder);
            } else {
                await sendCancellationNotification(notifyCreds, notifyOrder);
            }
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
    supabase: SupabaseClient,
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
    try {
        const access = await requireOrgContext();
        if (!access.ok) return { success: false, message: access.error };
        const { supabase, orgId } = access;

        const parsed = bookingInputSchema.safeParse(raw);
        if (!parsed.success) {
            return { success: false, message: parsed.error.issues[0]?.message ?? 'Data tidak valid' };
        }
        const input = parsed.data;

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
    try {
        const access = await requireOrgContext();
        if (!access.ok) return { success: false, message: access.error };
        const { supabase, orgId } = access;

        const parsed = bookingInputSchema.safeParse(raw);
        if (!parsed.success) {
            return { success: false, message: parsed.error.issues[0]?.message ?? 'Data tidak valid' };
        }
        const input = parsed.data;

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
                .eq('org_id', orgId)
                .eq('id', id)
                .single();
            const existingItems = Array.isArray(existing?.items) ? existing.items : [];
            if (existingItems.length <= 1) patch.items = packageItems(input);
        }

        const { error } = await supabase
            .from('orders')
            .update(patch)
            .eq('org_id', orgId)
            .eq('id', id);
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
        const access = await requireOrgContext();
        if (!access.ok) return { success: false, message: access.error };
        const { supabase, orgId } = access;

        const { error } = await supabase
            .from('orders')
            .delete()
            .eq('org_id', orgId)
            .eq('id', id);
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
        const access = await requireOrgContext();
        if (!access.ok) return { success: false, message: access.error };
        const { supabase, orgId } = access;

        const { error } = await supabase
            .from('orders')
            .update({
                dp_paid_at: paid ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
            })
            .eq('org_id', orgId)
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
        const access = await requireOrgContext();
        if (!access.ok) return { success: false, message: access.error };
        const { supabase, orgId } = access;

        const patch: Record<string, unknown> = {
            pelunasan_paid_at: paid ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
        };
        if (paid) {
            const { data } = await supabase
                .from('orders')
                .select('total_amount, dp_amount')
                .eq('org_id', orgId)
                .eq('id', id)
                .single();
            if (data) {
                patch.pelunasan_amount = remainingBalance(
                    Number(data.total_amount),
                    Number(data.dp_amount)
                );
            }
        }
        const { error } = await supabase
            .from('orders')
            .update(patch)
            .eq('org_id', orgId)
            .eq('id', id);
        if (error) return { success: false, message: error.message };
        return { success: true, message: paid ? 'Booking ditandai lunas' : 'Tanda lunas dibatalkan' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Gagal memperbarui pelunasan',
        };
    }
}
