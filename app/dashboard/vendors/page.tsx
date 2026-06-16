'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { VendorList } from '@/components/dashboard/VendorList';
import {
    VendorDialog,
    VENDOR_CATEGORY_OPTIONS,
    type Vendor,
    type VendorCategory,
} from '@/components/dashboard/VendorDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Building2, Plus, Loader2, Search } from 'lucide-react';

type CategoryFilter = 'all' | VendorCategory;

function VendorsDirectory() {
    const searchParams = useSearchParams();
    const [vendors, setVendors] = useState<Vendor[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [vendorToEdit, setVendorToEdit] = useState<Vendor | null>(null);
    // Deep link from Contacts "Buka di direktori": /dashboard/vendors?q=<vendor name>
    // Derived once during render so we never setState in an effect.
    const [searchQuery, setSearchQuery] = useState(() => searchParams.get('q') ?? '');
    const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');

    const fetchVendors = async () => {
        try {
            const response = await fetch('/api/vendors');
            if (!response.ok) throw new Error('Failed to fetch vendors');
            const data = await response.json();
            setVendors((data.vendors ?? []) as Vendor[]);
        } catch (error) {
            console.error('Error fetching vendors:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchVendors();
    }, []);

    const handleAdd = () => {
        setVendorToEdit(null);
        setDialogOpen(true);
    };

    const handleEdit = (vendor: Vendor) => {
        setVendorToEdit(vendor);
        setDialogOpen(true);
    };

    const filtered = vendors.filter((v) => {
        if (categoryFilter !== 'all' && v.category !== categoryFilter) return false;
        if (searchQuery.trim().length === 0) return true;
        const q = searchQuery.toLowerCase();
        return (
            v.name.toLowerCase().includes(q) ||
            (v.contact_person ?? '').toLowerCase().includes(q) ||
            (v.phone ?? '').toLowerCase().includes(q) ||
            (v.email ?? '').toLowerCase().includes(q)
        );
    });

    const countByCategory = vendors.reduce<Record<string, number>>((acc, v) => {
        acc[v.category] = (acc[v.category] ?? 0) + 1;
        return acc;
    }, {});

    return (
        <div className="space-y-6 md:space-y-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Vendor Directory</h1>
                    <p className="text-muted-foreground">
                        Direktori kontak vendor (catering, venue, transport, dll.) untuk koordinasi event.
                    </p>
                </div>
                <Button onClick={handleAdd}>
                    <Plus className="mr-2 h-4 w-4" />
                    Tambah Vendor
                </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Vendor</CardTitle>
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        ) : (
                            <div className="text-2xl font-bold">{vendors.length}</div>
                        )}
                    </CardContent>
                </Card>
                <Card className="md:col-span-2">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">Distribusi Kategori</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        ) : (
                            <div className="flex flex-wrap gap-2 text-xs">
                                {VENDOR_CATEGORY_OPTIONS.map((opt) => (
                                    <span
                                        key={opt.value}
                                        className="rounded-md border bg-muted/50 px-2 py-1"
                                    >
                                        {opt.label}:{' '}
                                        <strong className="text-foreground">
                                            {countByCategory[opt.value] ?? 0}
                                        </strong>
                                    </span>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <div className="relative w-full sm:flex-1 sm:min-w-[240px] sm:max-w-md">
                        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Cari nama, PIC, telepon, email..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-8"
                        />
                    </div>
                    <Select
                        value={categoryFilter}
                        onValueChange={(value) => setCategoryFilter(value as CategoryFilter)}
                    >
                        <SelectTrigger className="w-full sm:w-[200px]">
                            <SelectValue placeholder="Semua kategori" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Semua kategori</SelectItem>
                            {VENDOR_CATEGORY_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <VendorList
                        vendors={filtered}
                        onRefresh={fetchVendors}
                        onEditVendor={handleEdit}
                    />
                )}
            </div>

            <VendorDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                vendorToEdit={vendorToEdit}
                onSuccess={fetchVendors}
            />
        </div>
    );
}

export default function VendorsPage() {
    return (
        <Suspense fallback={null}>
            <VendorsDirectory />
        </Suspense>
    );
}
