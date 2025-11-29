'use client';

import { useState } from 'react';
import { Package, Trash2, Loader2, Edit, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    type: 'product' | 'service';
    created_at: string;
}

interface ProductListProps {
    products: Product[];
    onProductDeleted: () => void;
    onEditProduct: (product: Product) => void;
}

export function ProductList({ products, onProductDeleted, onEditProduct }: ProductListProps) {
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [productToDelete, setProductToDelete] = useState<Product | null>(null);

    const handleDeleteClick = (product: Product) => {
        setProductToDelete(product);
    };

    const confirmDelete = async () => {
        if (!productToDelete) return;

        const { id } = productToDelete;
        setDeletingId(id);
        setProductToDelete(null);

        try {
            const response = await fetch(`/api/products/${id}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                throw new Error('Failed to delete product');
            }

            toast.success('Product deleted successfully');
            onProductDeleted();
        } catch (error) {
            console.error('Error deleting product:', error);
            toast.error('Failed to delete product');
        } finally {
            setDeletingId(null);
        }
    };

    const formatPrice = (price: number) => {
        return new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0,
        }).format(price);
    };

    if (products.length === 0) {
        return (
            <div className="rounded-lg border border-white/10 bg-black/20 p-8 text-center">
                <Package className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 text-sm text-muted-foreground">
                    No items found. Add your first product or service to get started.
                </p>
            </div>
        );
    }

    return (
        <>
            <div className="space-y-2">
                {products.map((product) => (
                    <div
                        key={product.id}
                        className="group flex items-center justify-between rounded-lg border border-white/10 bg-black/20 p-4 transition-colors hover:bg-black/30"
                    >
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                                <Package className="h-5 w-5 text-primary" />
                            </div>
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <p className="font-medium text-sm">{product.name}</p>
                                    <Badge
                                        variant={product.type === 'product' ? 'default' : 'secondary'}
                                        className="h-4 px-1.5 text-[10px]"
                                    >
                                        {product.type === 'product' ? 'Product' : 'Service'}
                                    </Badge>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <span>{formatPrice(product.price)}</span>
                                    {product.type === 'product' && (
                                        <>
                                            <span>•</span>
                                            <span className={product.stock < 10 ? "text-red-400 font-medium" : ""}>
                                                Stock: {product.stock}
                                            </span>
                                            {product.stock === 0 && (
                                                <Badge variant="destructive" className="h-4 px-1 text-[10px]">Out of Stock</Badge>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onEditProduct(product)}
                                className="text-muted-foreground hover:text-primary"
                            >
                                <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteClick(product)}
                                disabled={deletingId === product.id}
                                className="text-muted-foreground hover:text-destructive"
                            >
                                {deletingId === product.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Trash2 className="h-4 w-4" />
                                )}
                            </Button>
                        </div>
                    </div>
                ))}
            </div>

            <Dialog open={!!productToDelete} onOpenChange={(open) => !open && setProductToDelete(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="h-5 w-5" />
                            Delete Product
                        </DialogTitle>
                        <DialogDescription>
                            Are you sure you want to delete <strong>{productToDelete?.name}</strong>?
                            <br />
                            This action cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setProductToDelete(null)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={confirmDelete}>
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
