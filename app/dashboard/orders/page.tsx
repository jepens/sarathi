import { OrderList } from './components/OrderList';

export default function OrdersPage() {
    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-medium">Manajemen Pesanan</h3>
                <p className="text-sm text-muted-foreground">
                    Lihat dan kelola pesanan produk serta booking jasa dari pelanggan.
                </p>
            </div>
            <OrderList />
        </div>
    );
}
