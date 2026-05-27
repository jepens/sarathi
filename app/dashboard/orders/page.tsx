import { OrderList } from './components/OrderList';

export default function OrdersPage() {
    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-medium">Bookings</h3>
                <p className="text-sm text-muted-foreground">
                    Lihat dan kelola booking event dari klien.
                </p>
            </div>
            <OrderList />
        </div>
    );
}
