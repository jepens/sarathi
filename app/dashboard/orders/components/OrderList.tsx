'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface OrderItem {
    name: string;
    qty: number;
    price: number;
    note?: string;
}

interface Order {
    id: string;
    customer_name: string;
    customer_phone: string;
    items: OrderItem[];
    total_amount: number;
    status: string;
    delivery_info: string;
    order_type: 'product' | 'service';
    created_at: string;
}

const STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'] as const;

function statusColor(status: string): string {
    switch (status) {
        case 'pending': return 'bg-yellow-500';
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

function itemsText(order: Order): string {
    if (!Array.isArray(order.items)) return 'Data item tidak valid';
    return order.items.map((i) => `${i.name} x${i.qty}`).join(', ');
}

function TypeBadge({ type }: { type: Order['order_type'] }) {
    return (
        <Badge variant={type === 'service' ? 'secondary' : 'outline'}>
            {type === 'service' ? 'Jasa' : 'Produk'}
        </Badge>
    );
}

// Shared status-cycle menu used by both the desktop table row and the mobile card.
function OrderActions({ order, onUpdate }: { order: Order; onUpdate: (id: string, status: string) => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="shrink-0">
                    <span className="sr-only">Open menu</span>
                    <MoreHorizontal className="h-4 w-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {STATUSES.map((s) => (
                    <DropdownMenuItem key={s} onClick={() => onUpdate(order.id, s)} className="capitalize">
                        Set {s}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function OrderList() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const supabase = createClient();

    const fetchOrders = useCallback(async () => {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching orders:', error);
            toast.error('Gagal memuat data pesanan');
            return [];
        }
        return data || [];
    }, [supabase]);

    useEffect(() => {
        let mounted = true;

        const load = async () => {
            try {
                const data = await fetchOrders();
                if (mounted) {
                    setOrders(data);
                    setLoading(false);
                }
            } catch (error) {
                console.error('Error loading orders:', error);
                if (mounted) setLoading(false);
            }
        };

        load();

        // Subscribe to realtime changes
        const channel = supabase
            .channel('orders_realtime')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, async () => {
                const data = await fetchOrders();
                if (mounted) setOrders(data);
            })
            .subscribe();

        return () => {
            mounted = false;
            supabase.removeChannel(channel);
        };
    }, [fetchOrders, supabase]);

    const updateStatus = async (id: string, newStatus: string) => {
        try {
            // Find the order to get current data
            const currentOrder = orders.find(o => o.id === id);
            if (!currentOrder) {
                toast.error('Order tidak ditemukan');
                return;
            }

            // Call server action to handle status update + stock operations
            const { updateOrderStatus } = await import('../actions');
            const result = await updateOrderStatus(id, newStatus, currentOrder);

            if (result.success) {
                toast.success(result.message);
            } else {
                toast.error(result.message);
            }

            // Refresh orders list
            const data = await fetchOrders();
            setOrders(data);
        } catch (error) {
            console.error('Error updating status:', error);
            toast.error('Terjadi kesalahan saat mengupdate status');
        }
    };

    if (loading) {
        return (
            <>
                {/* Desktop skeleton */}
                <div className="hidden rounded-md border md:block">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {['Tanggal', 'Pelanggan', 'Tipe', 'Items', 'Total', 'Info Pengiriman', 'Status', 'Aksi'].map((h) => (
                                    <TableHead key={h}>{h}</TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {Array.from({ length: 6 }).map((_, i) => (
                                <TableRow key={i}>
                                    {Array.from({ length: 8 }).map((_, j) => (
                                        <TableCell key={j}>
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
                {/* Mobile skeleton */}
                <div className="space-y-3 md:hidden">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="rounded-lg border p-4">
                            <Skeleton className="h-4 w-1/2" />
                            <Skeleton className="mt-2 h-3 w-1/3" />
                            <Skeleton className="mt-4 h-3 w-full" />
                            <Skeleton className="mt-2 h-3 w-2/3" />
                        </div>
                    ))}
                </div>
            </>
        );
    }

    if (orders.length === 0) {
        return (
            <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
                Belum ada pesanan.
            </div>
        );
    }

    return (
        <>
            {/* Desktop: full table */}
            <div className="hidden rounded-md border md:block">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Tanggal</TableHead>
                            <TableHead>Pelanggan</TableHead>
                            <TableHead>Tipe</TableHead>
                            <TableHead>Items</TableHead>
                            <TableHead>Total</TableHead>
                            <TableHead>Info Pengiriman</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Aksi</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {orders.map((order) => (
                            <TableRow key={order.id}>
                                <TableCell>{formatOrderDate(order.created_at)}</TableCell>
                                <TableCell>
                                    <div className="font-medium">{order.customer_name}</div>
                                    <div className="text-xs text-muted-foreground">{order.customer_phone}</div>
                                </TableCell>
                                <TableCell>
                                    <TypeBadge type={order.order_type} />
                                </TableCell>
                                <TableCell>
                                    <ul className="text-sm list-disc list-inside">
                                        {Array.isArray(order.items) ? (
                                            order.items.map((item, idx) => (
                                                <li key={idx}>
                                                    {item.name} x{item.qty}
                                                </li>
                                            ))
                                        ) : (
                                            <li className="text-red-500">Data item tidak valid</li>
                                        )}
                                    </ul>
                                </TableCell>
                                <TableCell>
                                    Rp {order.total_amount.toLocaleString('id-ID')}
                                </TableCell>
                                <TableCell className="max-w-[200px] truncate" title={order.delivery_info}>
                                    {order.delivery_info}
                                </TableCell>
                                <TableCell>
                                    <Badge className={statusColor(order.status)}>
                                        {order.status}
                                    </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                    <OrderActions order={order} onUpdate={updateStatus} />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            {/* Mobile: stacked cards (same data, no horizontal scroll) */}
            <div className="space-y-3 md:hidden">
                {orders.map((order) => (
                    <div key={order.id} className="rounded-lg border bg-card p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                                <div className="truncate font-medium">{order.customer_name}</div>
                                <div className="truncate text-xs text-muted-foreground">{order.customer_phone}</div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <Badge className={cn('capitalize', statusColor(order.status))}>
                                    {order.status}
                                </Badge>
                                <OrderActions order={order} onUpdate={updateStatus} />
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>{formatOrderDate(order.created_at)}</span>
                            <TypeBadge type={order.order_type} />
                        </div>

                        <p className="mt-2 text-sm">
                            <span className="text-muted-foreground">Items: </span>
                            {itemsText(order)}
                        </p>

                        {order.delivery_info && (
                            <p className="mt-1 text-sm">
                                <span className="text-muted-foreground">Pengiriman: </span>
                                {order.delivery_info}
                            </p>
                        )}

                        <div className="mt-3 flex items-center justify-between border-t pt-2">
                            <span className="text-xs text-muted-foreground">Total</span>
                            <span className="font-semibold">Rp {order.total_amount.toLocaleString('id-ID')}</span>
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}
