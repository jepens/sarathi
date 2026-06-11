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

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'pending': return 'bg-yellow-500';
            case 'paid': return 'bg-blue-500';
            case 'shipped': return 'bg-purple-500';
            case 'completed': return 'bg-green-500';
            case 'cancelled': return 'bg-red-500';
            default: return 'bg-gray-500';
        }
    };

    if (loading) {
        return (
            <div className="rounded-md border">
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
        );
    }

    return (
        <div className="rounded-md border">
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
                    {orders.length === 0 ? (
                        <TableRow>
                            <TableCell colSpan={8} className="text-center h-24">
                                Belum ada pesanan.
                            </TableCell>
                        </TableRow>
                    ) : (
                        orders.map((order) => (
                            <TableRow key={order.id}>
                                <TableCell>
                                    {new Date(order.created_at).toLocaleDateString('id-ID', {
                                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                                    })}
                                </TableCell>
                                <TableCell>
                                    <div className="font-medium">{order.customer_name}</div>
                                    <div className="text-xs text-muted-foreground">{order.customer_phone}</div>
                                </TableCell>
                                <TableCell>
                                    <Badge variant={order.order_type === 'service' ? 'secondary' : 'outline'}>
                                        {order.order_type === 'service' ? 'Jasa' : 'Produk'}
                                    </Badge>
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
                                    <Badge className={getStatusColor(order.status)}>
                                        {order.status}
                                    </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" className="h-8 w-8 p-0">
                                                <span className="sr-only">Open menu</span>
                                                <MoreHorizontal className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => updateStatus(order.id, 'pending')}>
                                                Set Pending
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => updateStatus(order.id, 'paid')}>
                                                Set Paid
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => updateStatus(order.id, 'shipped')}>
                                                Set Shipped
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => updateStatus(order.id, 'completed')}>
                                                Set Completed
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => updateStatus(order.id, 'cancelled')}>
                                                Set Cancelled
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </TableCell>
                            </TableRow>
                        ))
                    )}
                </TableBody>
            </Table>
        </div>
    );
}
