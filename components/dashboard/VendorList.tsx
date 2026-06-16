'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    Building2,
    Trash2,
    Loader2,
    Edit,
    AlertTriangle,
    Mail,
    Phone,
    MapPin,
    User,
    MessageCircle,
    BadgeCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { Vendor } from './VendorDialog';

const CATEGORY_LABEL: Record<Vendor['category'], string> = {
    catering: 'Catering',
    venue: 'Venue',
    transport: 'Transport',
    entertainment: 'Entertainment',
    photography: 'Photography',
    decoration: 'Decoration',
    mc: 'MC',
    other: 'Other',
};

interface VendorListProps {
    vendors: Vendor[];
    onRefresh: () => void;
    onEditVendor: (vendor: Vendor) => void;
}

export function VendorList({ vendors, onRefresh, onEditVendor }: VendorListProps) {
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [verifyingId, setVerifyingId] = useState<string | null>(null);
    const [vendorToDelete, setVendorToDelete] = useState<Vendor | null>(null);
    const router = useRouter();

    const toggleVerified = async (vendor: Vendor) => {
        setVerifyingId(vendor.id);
        try {
            const response = await fetch(`/api/vendors/${vendor.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ verified: !vendor.verified }),
            });
            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error || 'Failed to update verification');
            }
            toast.success(vendor.verified ? 'Verifikasi dibatalkan' : 'Vendor terverifikasi');
            onRefresh();
        } catch (error) {
            console.error('Error toggling verification:', error);
            toast.error(error instanceof Error ? error.message : 'Gagal memperbarui status');
        } finally {
            setVerifyingId(null);
        }
    };

    const confirmDelete = async () => {
        if (!vendorToDelete) return;
        const { id } = vendorToDelete;
        setDeletingId(id);
        setVendorToDelete(null);

        try {
            const response = await fetch(`/api/vendors/${id}`, { method: 'DELETE' });
            if (!response.ok) {
                const err = (await response.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error || 'Failed to delete vendor');
            }
            toast.success('Vendor dihapus');
            onRefresh();
        } catch (error) {
            console.error('Error deleting vendor:', error);
            toast.error(error instanceof Error ? error.message : 'Gagal menghapus vendor');
        } finally {
            setDeletingId(null);
        }
    };

    if (vendors.length === 0) {
        return (
            <div className="rounded-lg border bg-muted/30 p-8 text-center">
                <Building2 className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 text-sm text-muted-foreground">
                    Belum ada vendor. Tambah vendor pertama untuk membangun direktori kontak Anda.
                </p>
            </div>
        );
    }

    return (
        <>
            <div className="grid gap-3 md:grid-cols-2">
                {vendors.map((vendor) => (
                    <div
                        key={vendor.id}
                        className="group rounded-lg border bg-muted/30 p-4 transition-colors hover:bg-muted/60"
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1 space-y-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <p className="truncate font-medium text-sm">{vendor.name}</p>
                                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                                        {CATEGORY_LABEL[vendor.category]}
                                    </Badge>
                                    {vendor.verified && (
                                        <Badge
                                            variant="outline"
                                            className="h-4 gap-0.5 px-1.5 text-[10px] border-emerald-300 bg-emerald-50 text-emerald-700"
                                        >
                                            <BadgeCheck className="h-3 w-3" /> Terverifikasi
                                        </Badge>
                                    )}
                                </div>
                                <div className="space-y-1 text-xs text-muted-foreground">
                                    {vendor.contact_person && (
                                        <div className="flex items-center gap-1.5">
                                            <User className="h-3 w-3" />
                                            <span className="truncate">{vendor.contact_person}</span>
                                        </div>
                                    )}
                                    {vendor.phone && (
                                        <div className="flex items-center gap-1.5">
                                            <Phone className="h-3 w-3" />
                                            <a
                                                href={`tel:${vendor.phone}`}
                                                className="truncate hover:text-primary"
                                            >
                                                {vendor.phone}
                                            </a>
                                        </div>
                                    )}
                                    {vendor.email && (
                                        <div className="flex items-center gap-1.5">
                                            <Mail className="h-3 w-3" />
                                            <a
                                                href={`mailto:${vendor.email}`}
                                                className="truncate hover:text-primary"
                                            >
                                                {vendor.email}
                                            </a>
                                        </div>
                                    )}
                                    {vendor.address && (
                                        <div className="flex items-start gap-1.5">
                                            <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" />
                                            <span className="line-clamp-2">{vendor.address}</span>
                                        </div>
                                    )}
                                </div>
                                {vendor.notes && (
                                    <p className="line-clamp-2 text-xs italic text-muted-foreground/80">
                                        {vendor.notes}
                                    </p>
                                )}
                            </div>
                            <div className="flex flex-shrink-0 items-center gap-1">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => toggleVerified(vendor)}
                                    disabled={verifyingId === vendor.id}
                                    className={
                                        vendor.verified
                                            ? 'text-emerald-600 hover:text-emerald-700'
                                            : 'text-muted-foreground hover:text-emerald-600'
                                    }
                                    aria-label={
                                        vendor.verified
                                            ? `Batalkan verifikasi ${vendor.name}`
                                            : `Tandai ${vendor.name} terverifikasi`
                                    }
                                    title={
                                        vendor.verified
                                            ? 'Terverifikasi — klik untuk batalkan'
                                            : 'Tandai terverifikasi'
                                    }
                                >
                                    {verifyingId === vendor.id ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <BadgeCheck className="h-4 w-4" />
                                    )}
                                </Button>
                                {vendor.chat_phone && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            router.push(
                                                `/dashboard/chats?phone=${encodeURIComponent(vendor.chat_phone!)}`
                                            )
                                        }
                                        className="text-muted-foreground hover:text-emerald-600"
                                        aria-label={`Buka chat ${vendor.name}`}
                                        title="Buka chat WhatsApp"
                                    >
                                        <MessageCircle className="h-4 w-4" />
                                    </Button>
                                )}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onEditVendor(vendor)}
                                    className="text-muted-foreground hover:text-primary"
                                    aria-label={`Edit ${vendor.name}`}
                                >
                                    <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setVendorToDelete(vendor)}
                                    disabled={deletingId === vendor.id}
                                    className="text-muted-foreground hover:text-destructive"
                                    aria-label={`Hapus ${vendor.name}`}
                                >
                                    {deletingId === vendor.id ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Trash2 className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            <Dialog
                open={!!vendorToDelete}
                onOpenChange={(open) => !open && setVendorToDelete(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="h-5 w-5" />
                            Hapus Vendor
                        </DialogTitle>
                        <DialogDescription>
                            Hapus <strong>{vendorToDelete?.name}</strong>? Aksi ini tidak bisa
                            dibatalkan.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setVendorToDelete(null)}>
                            Batal
                        </Button>
                        <Button variant="destructive" onClick={confirmDelete}>
                            Hapus
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
