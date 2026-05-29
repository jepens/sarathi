'use client';

import { useEffect, useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { VENDOR_CATEGORIES, type VendorCategory } from '@/lib/vendors/categories';

export type { VendorCategory };

const CATEGORY_LABELS: Record<VendorCategory, string> = {
    catering: 'Catering',
    venue: 'Venue',
    transport: 'Transport',
    entertainment: 'Entertainment',
    photography: 'Photography',
    decoration: 'Decoration',
    mc: 'MC',
    other: 'Other',
};

export const VENDOR_CATEGORY_OPTIONS: { value: VendorCategory; label: string }[] =
    VENDOR_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }));

export interface Vendor {
    id: string;
    name: string;
    category: VendorCategory;
    contact_person: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
    chat_phone: string | null;
    verified: boolean;
    created_at: string;
    updated_at: string;
}

interface VendorFormState {
    name: string;
    category: VendorCategory;
    contact_person: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
}

const EMPTY_FORM: VendorFormState = {
    name: '',
    category: 'catering',
    contact_person: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
};

interface VendorDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    vendorToEdit?: Vendor | null;
    onSuccess: () => void;
}

export function VendorDialog({
    open,
    onOpenChange,
    vendorToEdit,
    onSuccess,
}: VendorDialogProps) {
    const [loading, setLoading] = useState(false);
    const [form, setForm] = useState<VendorFormState>(EMPTY_FORM);

    useEffect(() => {
        if (vendorToEdit) {
            setForm({
                name: vendorToEdit.name,
                category: vendorToEdit.category,
                contact_person: vendorToEdit.contact_person ?? '',
                phone: vendorToEdit.phone ?? '',
                email: vendorToEdit.email ?? '',
                address: vendorToEdit.address ?? '',
                notes: vendorToEdit.notes ?? '',
            });
        } else {
            setForm(EMPTY_FORM);
        }
    }, [vendorToEdit, open]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!form.name.trim()) {
            toast.error('Nama vendor wajib diisi');
            return;
        }

        setLoading(true);
        try {
            const url = vendorToEdit ? `/api/vendors/${vendorToEdit.id}` : '/api/vendors';
            const method = vendorToEdit ? 'PATCH' : 'POST';

            const response = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: form.name,
                    category: form.category,
                    contact_person: form.contact_person,
                    phone: form.phone,
                    email: form.email,
                    address: form.address,
                    notes: form.notes,
                }),
            });

            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error || 'Failed to save vendor');
            }

            toast.success(vendorToEdit ? 'Vendor diperbarui' : 'Vendor ditambahkan');
            onSuccess();
            onOpenChange(false);
        } catch (error) {
            console.error('Error saving vendor:', error);
            toast.error(error instanceof Error ? error.message : 'Gagal menyimpan vendor');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[520px]">
                <DialogHeader>
                    <DialogTitle>{vendorToEdit ? 'Edit Vendor' : 'Tambah Vendor'}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="name">Nama Vendor *</Label>
                            <Input
                                id="name"
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                placeholder="PT Catering Nusantara"
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="category">Kategori *</Label>
                            <Select
                                value={form.category}
                                onValueChange={(value) =>
                                    setForm({ ...form, category: value as VendorCategory })
                                }
                            >
                                <SelectTrigger id="category">
                                    <SelectValue placeholder="Pilih kategori" />
                                </SelectTrigger>
                                <SelectContent>
                                    {VENDOR_CATEGORY_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="contact_person">Contact Person (PIC)</Label>
                        <Input
                            id="contact_person"
                            value={form.contact_person}
                            onChange={(e) =>
                                setForm({ ...form, contact_person: e.target.value })
                            }
                            placeholder="Bapak Budi"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="phone">Telepon / WhatsApp</Label>
                            <Input
                                id="phone"
                                value={form.phone}
                                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                                placeholder="+62 812-3456-7890"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <Input
                                id="email"
                                type="email"
                                value={form.email}
                                onChange={(e) => setForm({ ...form, email: e.target.value })}
                                placeholder="vendor@example.com"
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="address">Alamat</Label>
                        <Input
                            id="address"
                            value={form.address}
                            onChange={(e) => setForm({ ...form, address: e.target.value })}
                            placeholder="Jl. Sudirman No. 1, Jakarta"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="notes">Catatan</Label>
                        <Textarea
                            id="notes"
                            value={form.notes}
                            onChange={(e) => setForm({ ...form, notes: e.target.value })}
                            placeholder="Range harga, pengalaman kolaborasi, dll."
                            rows={3}
                        />
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={loading}
                        >
                            Batal
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {vendorToEdit ? 'Update' : 'Simpan'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
