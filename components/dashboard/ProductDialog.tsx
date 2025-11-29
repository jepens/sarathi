'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

interface Product {
    id?: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    type: 'product' | 'service';
}


interface ProductDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    productToEdit?: Product | null;
    onSuccess: () => void;
}

export function ProductDialog({ open, onOpenChange, productToEdit, onSuccess }: ProductDialogProps) {
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState<Product>({
        name: '',
        description: '',
        price: 0,
        stock: 0,
        type: 'product',
    });

    useEffect(() => {
        if (productToEdit) {
            setFormData(productToEdit);
        } else {
            setFormData({
                name: '',
                description: '',
                price: 0,
                stock: 0,
                type: 'product',
            });
        }
    }, [productToEdit, open]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            const url = productToEdit ? `/api/products/${productToEdit.id}` : '/api/products';
            const method = productToEdit ? 'PATCH' : 'POST';

            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData),
            });

            if (!response.ok) {
                throw new Error('Failed to save product');
            }

            toast.success(productToEdit ? 'Product updated' : 'Product created');
            onSuccess();
            onOpenChange(false);
        } catch (error) {
            console.error('Error saving product:', error);
            toast.error('Failed to save product');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>{productToEdit ? 'Edit Product' : 'Add New Product'}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label>Type</Label>
                        <RadioGroup
                            value={formData.type}
                            onValueChange={(value: 'product' | 'service') => {
                                setFormData({
                                    ...formData,
                                    type: value,
                                    // Auto-set stock for services
                                    stock: value === 'service' ? 999999 : formData.stock
                                });
                            }}
                            className="flex gap-4"
                        >
                            <div className="flex items-center space-x-2">
                                <RadioGroupItem value="product" id="type-product" />
                                <Label htmlFor="type-product" className="font-normal cursor-pointer">Product</Label>
                            </div>
                            <div className="flex items-center space-x-2">
                                <RadioGroupItem value="service" id="type-service" />
                                <Label htmlFor="type-service" className="font-normal cursor-pointer">Service</Label>
                            </div>
                        </RadioGroup>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="name">Name</Label>
                        <Input
                            id="name"
                            value={formData.name}
                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                            required
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="description">Description</Label>
                        <Textarea
                            id="description"
                            value={formData.description}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            required
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="price">Price (IDR)</Label>
                            <Input
                                id="price"
                                type="number"
                                value={formData.price}
                                onChange={(e) => setFormData({ ...formData, price: Number(e.target.value) })}
                                required
                            />
                        </div>
                        {formData.type === 'product' && (
                            <div className="space-y-2">
                                <Label htmlFor="stock">Stock</Label>
                                <Input
                                    id="stock"
                                    type="number"
                                    value={formData.stock}
                                    onChange={(e) => setFormData({ ...formData, stock: Number(e.target.value) })}
                                    required
                                />
                            </div>
                        )}
                    </div>
                    <DialogFooter>
                        <Button type="submit" disabled={loading}>
                            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {productToEdit ? 'Update' : 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
