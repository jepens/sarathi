'use client';

import { useEffect, useState } from 'react';
import { ProductList } from '@/components/dashboard/ProductList';
import { ProductDialog } from '@/components/dashboard/ProductDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IntegrationInfoBanner } from '@/components/dashboard/IntegrationInfoBanner';
import { Package, Plus, Loader2, Search } from 'lucide-react';

interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    type: 'product' | 'service';
    created_at: string;
}

export default function ProductsPage() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [productToEdit, setProductToEdit] = useState<Product | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    const fetchProducts = async () => {
        try {
            const response = await fetch('/api/products');
            if (!response.ok) throw new Error('Failed to fetch products');

            const data = await response.json();
            setProducts(data.products || []);
        } catch (error) {
            console.error('Error fetching products:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchProducts();
    }, []);

    const handleAddProduct = () => {
        setProductToEdit(null);
        setDialogOpen(true);
    };

    const handleEditProduct = (product: Product) => {
        setProductToEdit(product);
        setDialogOpen(true);
    };

    const handleSuccess = () => {
        fetchProducts();
    };

    const filteredProducts = products.filter(product =>
        product.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="space-y-6 md:space-y-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Paket Acara</h1>
                    <p className="text-muted-foreground">
                        Kelola katalog paket acara dan layanan EO Anda.
                    </p>
                </div>
                <Button onClick={handleAddProduct}>
                    <Plus className="mr-2 h-4 w-4" />
                    Tambah Paket
                </Button>
            </div>

            {/* AI Integration Info */}
            <IntegrationInfoBanner type="products" />

            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Items</CardTitle>
                        <Package className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        ) : (
                            <div className="text-2xl font-bold">{products.length}</div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <div className="space-y-4">
                <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Cari paket..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-8 max-w-sm"
                    />
                </div>

                {loading ? (
                    <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <ProductList
                        products={filteredProducts}
                        onProductDeleted={fetchProducts}
                        onEditProduct={handleEditProduct}
                    />
                )}
            </div>

            <ProductDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                productToEdit={productToEdit}
                onSuccess={handleSuccess}
            />
        </div>
    );
}
