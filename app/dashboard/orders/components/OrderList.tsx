'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useCurrentOrgId } from '@/components/current-org-provider';
import { useCoalesced, useOrgRealtime } from '@/components/realtime/org-realtime-provider';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { MoreHorizontal, Plus, Pencil, Trash2, Eye, CheckCircle2, Download, Video, Copy } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { BookingDialog } from '@/components/dashboard/BookingDialog';
import { remainingBalance, formatRupiah, BOOKING_STATUS_OPTIONS } from '@/lib/bookings/schema';
import { downloadCsv, csvDateStamp } from '@/lib/utils/csv';
import { deleteBooking, setDpPaid, setSettled } from '../actions';

interface OrderItem {
    name: string;
    qty: number;
    price: number;
    note?: string;
}

interface Order {
    id: string;
    customer_name: string;
    customer_phone: string | null;
    items: OrderItem[];
    total_amount: number;
    status: string;
    delivery_info: string | null;
    order_type: 'product' | 'service';
    created_at: string;
    event_type: string | null;
    event_date: string | null;
    venue: string | null;
    headcount: number | null;
    dp_amount: number | null;
    dp_paid_at: string | null;
    pelunasan_amount: number | null;
    pelunasan_paid_at: string | null;
    meeting_link: string | null;
    meeting_duration_min: number | null;
}

type Segment = 'all' | 'event' | 'meeting';

const STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'] as const;

// Meetings only ever use these statuses. Excluding paid/cancelled keeps the
// admin from triggering updateOrderStatus's payment/cancellation WhatsApp
// side-effects (meaningless for a free consultation). Cancelling a meeting is
// done by DELETING it (the "Batalkan" action) — which also frees the slot;
// a 'cancelled' status would leave the slot blocked (the RPC keys off row
// existence, not status).
const MEETING_STATUS_OPTIONS = [
    { value: 'scheduled', label: 'Terjadwal' },
    { value: 'completed', label: 'Selesai' },
] as const;

function statusColor(status: string): string {
    switch (status) {
        case 'pending': return 'bg-yellow-500';
        case 'scheduled': return 'bg-cyan-500';
        case 'paid': return 'bg-blue-500';
        case 'shipped': return 'bg-purple-500';
        case 'completed': return 'bg-green-500';
        case 'cancelled': return 'bg-red-500';
        default: return 'bg-gray-500';
    }
}

function formatOrderDate(iso: string): string {
    return new Date(iso).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
}

function formatEventDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta',
    });
}

function itemsText(order: Order): string {
    if (!Array.isArray(order.items) || order.items.length === 0) return '—';
    return order.items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}`).join(', ');
}

// --- Online-meeting helpers -------------------------------------------------
// A row is an online meeting (Zoom consultation) rather than a commercial event
// booking when it carries a meeting_link — the same signal the Calendar uses.
function isMeeting(o: Order): boolean {
    return !!o.meeting_link;
}
// The Zoom link is usable only once provisioned (not the 'pending-link' sentinel).
function meetingJoinUrl(o: Order): string | null {
    return o.meeting_link && o.meeting_link !== 'pending-link' ? o.meeting_link : null;
}
// The meeting's actual start time in WIB (+ duration) — NOT when the row was made.
function formatMeetingWhen(o: Order): string {
    if (!o.event_date) return '—';
    const when = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    }).format(new Date(o.event_date));
    return `${when} WIB · ${o.meeting_duration_min ?? 40} mnt`;
}
// Short topic label for a meeting row, cleaned of the internal "Online meeting —" prefix.
function meetingTopic(o: Order): string {
    const d = o.delivery_info?.trim();
    if (!d || d === 'Online meeting') return 'Konsultasi online';
    return d.replace(/^Online meeting\s*—\s*/i, '');
}
async function copyMeetingLink(url: string) {
    try {
        await navigator.clipboard.writeText(url);
        toast.success('Link Zoom disalin');
    } catch {
        toast.error('Gagal menyalin link');
    }
}

function bookingToCsvRow(o: Order): Record<string, string> {
    const items = Array.isArray(o.items) && o.items.length ? o.items.map((i) => i.name).join('; ') : '';
    return {
        pelanggan: o.customer_name ?? '',
        nomor_hp: o.customer_phone ?? '',
        tipe: isMeeting(o) ? 'Meeting' : o.order_type === 'service' ? 'Jasa' : 'Produk',
        jenis_acara: o.event_type ?? '',
        tanggal_acara: o.event_date ? formatEventDate(o.event_date) : '',
        waktu_meeting: isMeeting(o) ? formatMeetingWhen(o) : '',
        link_meeting: meetingJoinUrl(o) ?? '',
        lokasi: o.venue ?? '',
        jumlah_tamu: o.headcount != null ? String(o.headcount) : '',
        paket: items,
        total: String(o.total_amount ?? 0),
        dp: String(o.dp_amount ?? 0),
        sisa: String(remainingBalance(Number(o.total_amount ?? 0), Number(o.dp_amount ?? 0))),
        status: o.status,
        dp_dibayar: o.dp_paid_at ? formatEventDate(o.dp_paid_at) : '',
        lunas: o.pelunasan_paid_at ? formatEventDate(o.pelunasan_paid_at) : '',
        dibuat: formatOrderDate(o.created_at),
    };
}

function TypeBadge({ type }: { type: Order['order_type'] }) {
    return (
        <Badge variant={type === 'service' ? 'secondary' : 'outline'}>
            {type === 'service' ? 'Jasa' : 'Produk'}
        </Badge>
    );
}

function MeetingBadge() {
    return (
        <Badge
            variant="outline"
            className="border-violet-500/30 bg-violet-500/15 text-violet-700 dark:text-violet-300"
        >
            Meeting
        </Badge>
    );
}

// Compact Zoom link cell: Join (opens) + copy. Shows a muted note when the link
// hasn't been provisioned yet (still 'pending-link').
function MeetingLinkCell({ order }: { order: Order }) {
    const url = meetingJoinUrl(order);
    if (!url) return <span className="text-xs text-muted-foreground">Link belum siap</span>;
    return (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-violet-600 hover:underline dark:text-violet-400"
            >
                <Video className="h-3.5 w-3.5" /> Join
            </a>
            <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6"
                title="Salin link"
                onClick={() => copyMeetingLink(url)}
            >
                <Copy className="h-3 w-3" />
            </Button>
        </div>
    );
}

// Row actions — meeting rows get Zoom/complete/cancel; event rows keep the
// commercial edit + status-cycle + delete menu.
function OrderActions({
    order,
    onSetStatus,
    onDetail,
    onEdit,
    onDelete,
}: {
    order: Order;
    onSetStatus: (id: string, status: string) => void;
    onDetail: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const meeting = isMeeting(order);
    const joinUrl = meetingJoinUrl(order);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                >
                    <span className="sr-only">Open menu</span>
                    <MoreHorizontal className="h-4 w-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={onDetail}>
                    <Eye className="mr-2 h-3.5 w-3.5" /> Lihat detail
                </DropdownMenuItem>

                {meeting ? (
                    <>
                        {joinUrl && (
                            <>
                                <DropdownMenuItem
                                    onClick={() => window.open(joinUrl, '_blank', 'noopener,noreferrer')}
                                >
                                    <Video className="mr-2 h-3.5 w-3.5" /> Join Zoom
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => copyMeetingLink(joinUrl)}>
                                    <Copy className="mr-2 h-3.5 w-3.5" /> Salin link
                                </DropdownMenuItem>
                            </>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onSetStatus(order.id, 'completed')}>
                            <CheckCircle2 className="mr-2 h-3.5 w-3.5" /> Tandai selesai
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={onDelete}
                            className="text-destructive focus:text-destructive"
                        >
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Batalkan
                        </DropdownMenuItem>
                    </>
                ) : (
                    <>
                        <DropdownMenuItem onClick={onEdit}>
                            <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Ubah status</DropdownMenuLabel>
                        {STATUSES.map((s) => (
                            <DropdownMenuItem key={s} onClick={() => onSetStatus(order.id, s)} className="capitalize">
                                {s}
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={onDelete}
                            className="text-destructive focus:text-destructive"
                        >
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Hapus
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function OrderList() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const [segment, setSegment] = useState<Segment>('all');
    const [addOpen, setAddOpen] = useState(false);
    const [editOrder, setEditOrder] = useState<Order | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Order | null>(null);
    const [detailId, setDetailId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const supabase = createClient();
    const orgId = useCurrentOrgId();

    const fetchOrders = useCallback(async (): Promise<Order[]> => {
        if (!orgId) return [];
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .eq('org_id', orgId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching orders:', error);
            toast.error('Gagal memuat data pesanan');
            return [];
        }
        return (data as Order[]) || [];
    }, [supabase, orgId]);

    const refresh = useCallback(async () => {
        setOrders(await fetchOrders());
    }, [fetchOrders]);

    useEffect(() => {
        let mounted = true;
        const load = async () => {
            const data = await fetchOrders();
            if (mounted) {
                setOrders(data);
                setLoading(false);
            }
        };
        load();

        return () => {
            mounted = false;
        };
    }, [fetchOrders]);

    // Live (tracker 1.9): orders is on the org Realtime bus (0064), so a booking
    // the AI makes or a change in another tab shows up without a reload. A
    // delete names its ids: drop those rows; anything else refetches
    // (coalesced).
    const refreshSoon = useCoalesced(refresh);
    useOrgRealtime('orders', (signal) => {
        if (signal.op === 'DELETE' && !signal.truncated) {
            const gone = new Set(signal.ids);
            setOrders((cur) => cur.filter((o) => !gone.has(o.id)));
        } else {
            refreshSoon();
        }
    });

    const meetingCount = orders.filter(isMeeting).length;
    const eventCount = orders.length - meetingCount;
    const filtered = orders.filter((o) =>
        segment === 'all' ? true : segment === 'meeting' ? isMeeting(o) : !isMeeting(o)
    );
    const meetingView = segment === 'meeting';

    const detailOrder = detailId ? orders.find((o) => o.id === detailId) ?? null : null;

    const updateStatus = async (id: string, newStatus: string) => {
        if (!orders.some((o) => o.id === id)) {
            toast.error('Order tidak ditemukan');
            return;
        }
        try {
            const { updateOrderStatus } = await import('../actions');
            // The server reads the order (status, items, customer) from the DB
            // itself — only the id + target status are sent.
            const result = await updateOrderStatus(id, newStatus);
            if (result.success) toast.success(result.message);
            else toast.error(result.message);
            await refresh();
        } catch (error) {
            console.error('Error updating status:', error);
            toast.error('Terjadi kesalahan saat mengupdate status');
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setBusy(true);
        try {
            const result = await deleteBooking(deleteTarget.id);
            if (result.success) {
                setOrders((cur) => cur.filter((o) => o.id !== deleteTarget.id));
                toast.success(result.message);
                setDeleteTarget(null);
            } else {
                toast.error(result.message);
            }
        } finally {
            setBusy(false);
        }
    };

    const handleDpPaid = async (order: Order, paid: boolean) => {
        setBusy(true);
        try {
            const result = await setDpPaid(order.id, paid);
            if (result.success) toast.success(result.message);
            else toast.error(result.message);
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const handleSettled = async (order: Order, paid: boolean) => {
        setBusy(true);
        try {
            const result = await setSettled(order.id, paid);
            if (result.success) toast.success(result.message);
            else toast.error(result.message);
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const toolbar = (
        <div className="flex flex-shrink-0 items-center justify-end gap-2">
            <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={filtered.length === 0}
                onClick={() => downloadCsv(`bookings-${csvDateStamp()}.csv`, filtered.map(bookingToCsvRow))}
            >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Export</span>
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" /> Buat Booking
            </Button>
        </div>
    );

    const segmentTabs = (
        <Tabs value={segment} onValueChange={(v) => setSegment(v as Segment)}>
            <TabsList>
                <TabsTrigger value="all">
                    Semua <span className="ml-1.5 tabular-nums opacity-60">{orders.length}</span>
                </TabsTrigger>
                <TabsTrigger value="event">
                    Event <span className="ml-1.5 tabular-nums opacity-60">{eventCount}</span>
                </TabsTrigger>
                <TabsTrigger value="meeting">
                    Meeting <span className="ml-1.5 tabular-nums opacity-60">{meetingCount}</span>
                </TabsTrigger>
            </TabsList>
        </Tabs>
    );

    const dialogs = (
        <>
            <BookingDialog open={addOpen} onOpenChange={setAddOpen} onSuccess={refresh} />
            <BookingDialog
                key={editOrder?.id ?? 'none'}
                open={!!editOrder}
                onOpenChange={(o) => !o && setEditOrder(null)}
                onSuccess={refresh}
                bookingToEdit={editOrder}
            />

            {/* Detail panel */}
            <Dialog open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
                <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[520px]">
                    {detailOrder && isMeeting(detailOrder) ? (
                        // ---- Meeting detail (no payment/commercial fields) ----
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex flex-wrap items-center gap-2">
                                    <span>{detailOrder.customer_name}</span>
                                    <Badge className={cn('capitalize', statusColor(detailOrder.status))}>
                                        {detailOrder.status}
                                    </Badge>
                                    <MeetingBadge />
                                </DialogTitle>
                                {detailOrder.customer_phone && (
                                    <DialogDescription>{detailOrder.customer_phone}</DialogDescription>
                                )}
                            </DialogHeader>

                            <div className="grid gap-2 text-sm">
                                <DetailRow label="Waktu" value={formatMeetingWhen(detailOrder)} />
                                <DetailRow label="Topik" value={meetingTopic(detailOrder)} />
                                <DetailRow label="Catatan" value={detailOrder.delivery_info} />
                            </div>

                            {/* Zoom link */}
                            <div className="rounded-md border bg-muted/30 p-3 text-sm">
                                {meetingJoinUrl(detailOrder) ? (
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <a
                                            href={meetingJoinUrl(detailOrder)!}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1.5 font-medium text-violet-600 hover:underline dark:text-violet-400"
                                        >
                                            <Video className="h-4 w-4" /> Join Zoom Meeting
                                        </a>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => copyMeetingLink(meetingJoinUrl(detailOrder)!)}
                                        >
                                            <Copy className="mr-1.5 h-3.5 w-3.5" /> Salin link
                                        </Button>
                                    </div>
                                ) : (
                                    <span className="text-muted-foreground">
                                        Link Zoom belum tersedia (masih diproses / diisi manual oleh admin).
                                    </span>
                                )}
                            </div>

                            {/* Status */}
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Status</span>
                                <Select
                                    value={detailOrder.status}
                                    onValueChange={(v) => updateStatus(detailOrder.id, v)}
                                >
                                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {MEETING_STATUS_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <DialogFooter className="gap-2 sm:gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    onClick={() => { const o = detailOrder; setDetailId(null); setDeleteTarget(o); }}
                                >
                                    <Trash2 className="mr-2 h-4 w-4" /> Batalkan
                                </Button>
                            </DialogFooter>
                        </>
                    ) : detailOrder ? (
                        // ---- Event booking detail (payment tracking) ----
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex flex-wrap items-center gap-2">
                                    <span>{detailOrder.customer_name}</span>
                                    <Badge className={cn('capitalize', statusColor(detailOrder.status))}>
                                        {detailOrder.status}
                                    </Badge>
                                    <TypeBadge type={detailOrder.order_type} />
                                </DialogTitle>
                                {detailOrder.customer_phone && (
                                    <DialogDescription>{detailOrder.customer_phone}</DialogDescription>
                                )}
                            </DialogHeader>

                            <div className="grid gap-2 text-sm">
                                <DetailRow label="Jenis acara" value={detailOrder.event_type} />
                                <DetailRow label="Tanggal" value={formatEventDate(detailOrder.event_date)} />
                                <DetailRow label="Lokasi" value={detailOrder.venue} />
                                <DetailRow
                                    label="Tamu"
                                    value={detailOrder.headcount ? `${detailOrder.headcount} pax` : null}
                                />
                                <DetailRow label="Paket / item" value={itemsText(detailOrder)} />
                                <DetailRow label="Catatan" value={detailOrder.delivery_info} />
                            </div>

                            {/* Payment tracking */}
                            <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                                <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">Total</span>
                                    <span className="font-semibold">{formatRupiah(detailOrder.total_amount)}</span>
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-muted-foreground">
                                        DP: {formatRupiah(detailOrder.dp_amount)}
                                        {detailOrder.dp_paid_at && (
                                            <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                                                · dibayar {formatEventDate(detailOrder.dp_paid_at)}
                                            </span>
                                        )}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant={detailOrder.dp_paid_at ? 'outline' : 'default'}
                                        disabled={busy}
                                        onClick={() => handleDpPaid(detailOrder, !detailOrder.dp_paid_at)}
                                    >
                                        {detailOrder.dp_paid_at ? 'Batalkan DP' : 'Tandai DP dibayar'}
                                    </Button>
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                                    <span className="text-muted-foreground">
                                        Sisa:{' '}
                                        {formatRupiah(
                                            remainingBalance(
                                                Number(detailOrder.total_amount ?? 0),
                                                Number(detailOrder.dp_amount ?? 0)
                                            )
                                        )}
                                        {detailOrder.pelunasan_paid_at && (
                                            <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                                                · lunas {formatEventDate(detailOrder.pelunasan_paid_at)}
                                            </span>
                                        )}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant={detailOrder.pelunasan_paid_at ? 'outline' : 'default'}
                                        disabled={busy}
                                        onClick={() => handleSettled(detailOrder, !detailOrder.pelunasan_paid_at)}
                                    >
                                        {detailOrder.pelunasan_paid_at ? (
                                            'Batalkan lunas'
                                        ) : (
                                            <>
                                                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Tandai lunas
                                            </>
                                        )}
                                    </Button>
                                </div>
                            </div>

                            {/* Status */}
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Status</span>
                                <Select
                                    value={detailOrder.status}
                                    onValueChange={(v) => updateStatus(detailOrder.id, v)}
                                >
                                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {BOOKING_STATUS_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <DialogFooter className="gap-2 sm:gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    onClick={() => { const o = detailOrder; setDetailId(null); setDeleteTarget(o); }}
                                >
                                    <Trash2 className="mr-2 h-4 w-4" /> Hapus
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={() => { const o = detailOrder; setDetailId(null); setEditOrder(o); }}
                                >
                                    <Pencil className="mr-2 h-4 w-4" /> Edit
                                </Button>
                            </DialogFooter>
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>

            {/* Delete confirm */}
            <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {deleteTarget && isMeeting(deleteTarget) ? 'Batalkan meeting?' : 'Hapus booking?'}
                        </DialogTitle>
                        <DialogDescription>
                            {deleteTarget && isMeeting(deleteTarget) ? (
                                <>
                                    Meeting{' '}
                                    <span className="font-medium text-foreground">{deleteTarget?.customer_name}</span>{' '}
                                    akan dibatalkan & dihapus dari kalender, dan slot-nya kembali kosong. Tindakan ini
                                    tidak bisa dibatalkan.
                                </>
                            ) : (
                                <>
                                    Booking{' '}
                                    <span className="font-medium text-foreground">{deleteTarget?.customer_name}</span>{' '}
                                    akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.
                                </>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={busy}>
                            Batal
                        </Button>
                        <Button variant="destructive" onClick={handleDelete} disabled={busy}>
                            {busy ? 'Memproses…' : deleteTarget && isMeeting(deleteTarget) ? 'Batalkan meeting' : 'Hapus'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );

    if (loading) {
        return (
            <div className="space-y-3">
                {toolbar}
                <div className="hidden rounded-md border md:block">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {['Tanggal', 'Pelanggan', 'Tipe', 'Items', 'Total', 'Status', 'Aksi'].map((h) => (
                                    <TableHead key={h}>{h}</TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {Array.from({ length: 6 }).map((_, i) => (
                                <TableRow key={i}>
                                    {Array.from({ length: 7 }).map((_, j) => (
                                        <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                    ))}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
                <div className="space-y-3 md:hidden">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="rounded-lg border p-4">
                            <Skeleton className="h-4 w-1/2" />
                            <Skeleton className="mt-2 h-3 w-1/3" />
                            <Skeleton className="mt-4 h-3 w-full" />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                {segmentTabs}
                {toolbar}
            </div>

            {orders.length === 0 ? (
                <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
                    Belum ada booking. Klik <span className="font-medium">Buat Booking</span> untuk menambah.
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
                    {meetingView
                        ? 'Belum ada meeting online. Meeting yang dijadwalkan lewat WhatsApp akan muncul di sini.'
                        : 'Belum ada booking event.'}
                </div>
            ) : (
                <>
                    {/* Desktop: full table */}
                    <div className="hidden rounded-md border md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{meetingView ? 'Waktu (WIB)' : 'Tanggal'}</TableHead>
                                    <TableHead>Pelanggan</TableHead>
                                    <TableHead>Tipe</TableHead>
                                    <TableHead>{meetingView ? 'Topik' : 'Items'}</TableHead>
                                    <TableHead>
                                        {meetingView ? 'Link Zoom' : segment === 'all' ? 'Total / Link' : 'Total'}
                                    </TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead className="text-right">Aksi</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map((order) => {
                                    const meeting = isMeeting(order);
                                    return (
                                        <TableRow
                                            key={order.id}
                                            className="cursor-pointer"
                                            onClick={() => setDetailId(order.id)}
                                        >
                                            <TableCell className="whitespace-nowrap">
                                                {meeting ? formatMeetingWhen(order) : formatOrderDate(order.created_at)}
                                            </TableCell>
                                            <TableCell>
                                                <div className="font-medium">{order.customer_name}</div>
                                                <div className="text-xs text-muted-foreground">{order.customer_phone}</div>
                                            </TableCell>
                                            <TableCell>
                                                {meeting ? <MeetingBadge /> : <TypeBadge type={order.order_type} />}
                                            </TableCell>
                                            <TableCell
                                                className="max-w-[220px] truncate"
                                                title={meeting ? meetingTopic(order) : itemsText(order)}
                                            >
                                                {meeting ? meetingTopic(order) : itemsText(order)}
                                            </TableCell>
                                            <TableCell>
                                                {meeting ? (
                                                    <MeetingLinkCell order={order} />
                                                ) : (
                                                    formatRupiah(order.total_amount)
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <Badge className={cn('capitalize', statusColor(order.status))}>
                                                    {order.status}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <OrderActions
                                                    order={order}
                                                    onSetStatus={updateStatus}
                                                    onDetail={() => setDetailId(order.id)}
                                                    onEdit={() => setEditOrder(order)}
                                                    onDelete={() => setDeleteTarget(order)}
                                                />
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>

                    {/* Mobile: stacked cards */}
                    <div className="space-y-3 md:hidden">
                        {filtered.map((order) => {
                            const meeting = isMeeting(order);
                            return (
                                <div
                                    key={order.id}
                                    className="cursor-pointer rounded-lg border bg-card p-4 shadow-sm"
                                    onClick={() => setDetailId(order.id)}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="truncate font-medium">{order.customer_name}</div>
                                            <div className="truncate text-xs text-muted-foreground">{order.customer_phone}</div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <Badge className={cn('capitalize', statusColor(order.status))}>
                                                {order.status}
                                            </Badge>
                                            <OrderActions
                                                order={order}
                                                onSetStatus={updateStatus}
                                                onDetail={() => setDetailId(order.id)}
                                                onEdit={() => setEditOrder(order)}
                                                onDelete={() => setDeleteTarget(order)}
                                            />
                                        </div>
                                    </div>
                                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                        <span>{meeting ? formatMeetingWhen(order) : formatOrderDate(order.created_at)}</span>
                                        {meeting ? <MeetingBadge /> : <TypeBadge type={order.order_type} />}
                                    </div>
                                    <p className="mt-2 text-sm">
                                        <span className="text-muted-foreground">{meeting ? 'Topik: ' : 'Items: '}</span>
                                        {meeting ? meetingTopic(order) : itemsText(order)}
                                    </p>
                                    <div className="mt-3 flex items-center justify-between border-t pt-2">
                                        {meeting ? (
                                            <>
                                                <span className="text-xs text-muted-foreground">Zoom</span>
                                                <MeetingLinkCell order={order} />
                                            </>
                                        ) : (
                                            <>
                                                <span className="text-xs text-muted-foreground">Total</span>
                                                <span className="font-semibold">{formatRupiah(order.total_amount)}</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}

            {dialogs}
        </div>
    );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
    return (
        <div className="flex gap-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
            <span className="min-w-0 break-words">{value || <span className="text-muted-foreground">—</span>}</span>
        </div>
    );
}
