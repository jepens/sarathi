'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { stripAuditLines } from '@/lib/proposals/notes';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Search,
    Edit2,
    Trash2,
    User,
    Lock,
    Sparkles,
    Mail,
    MapPin,
    CalendarDays,
    Users,
    Target,
    Wallet,
    Tag,
    Phone,
    StickyNote,
    UserCheck,
    Store,
    Package,
} from 'lucide-react';
import { toast } from 'sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { VENDOR_CATEGORIES } from '@/lib/vendors/categories';
import { ContactTypeBadge } from '@/components/dashboard/ContactTypeBadge';

// Pipeline stages — mirror whatsapp_chats.lead_stage check constraint.
const STAGE_META: Record<string, { label: string; className: string }> = {
    new: { label: 'Baru', className: 'bg-slate-100 text-slate-700' },
    qualifying: { label: 'Kualifikasi', className: 'bg-blue-100 text-blue-700' },
    quoted: { label: 'Penawaran', className: 'bg-amber-100 text-amber-700' },
    scheduled: { label: 'Meeting', className: 'bg-violet-100 text-violet-700' },
    booked: { label: 'Booked', className: 'bg-indigo-100 text-indigo-700' },
    won: { label: 'Closing', className: 'bg-green-100 text-green-700' },
    lost: { label: 'Lost', className: 'bg-red-100 text-red-700' },
};

type ContactType = 'lead' | 'vendor' | 'other';

// All lead/CRM fields the AI auto-captures into whatsapp_chats. See
// lib/ai/tools.ts (save_lead_info) + migrations 0002 / 0017.
interface Contact {
    phone_number: string;
    contact_name: string | null;
    contact_name_locked: boolean;
    contact_type: ContactType;
    vendor_category: string | null;
    vendor_offering: string | null;
    email: string | null;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    lead_stage: string | null;
    assigned_to: string | null;
    source: string | null;
    notes: string | null;
    last_message_at: string | null;
}

const CONTACT_COLUMNS =
    'phone_number, contact_name, contact_name_locked, contact_type, vendor_category, vendor_offering, email, event_interest, participant_count, location_pref, event_date_pref, event_goals, budget_range, lead_stage, assigned_to, source, notes, last_message_at';

function StageBadge({ stage }: { stage: string | null }) {
    if (!stage) return <span className="text-xs text-muted-foreground">—</span>;
    const meta = STAGE_META[stage] ?? { label: stage, className: 'bg-gray-100 text-gray-700' };
    return <Badge className={`${meta.className} border-transparent`}>{meta.label}</Badge>;
}

export function ContactList() {
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState<'all' | 'lead' | 'vendor'>('all');
    const [loading, setLoading] = useState(true);

    // Detail (CRM card) — keyed by phone so it stays in sync with realtime.
    const [detailPhone, setDetailPhone] = useState<string | null>(null);

    // Edit Dialog State
    const [isEditOpen, setIsEditOpen] = useState(false);
    const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
    const [editName, setEditName] = useState('');
    const [lockName, setLockName] = useState(true);

    // Delete Dialog State
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [contactToDelete, setContactToDelete] = useState<Contact | null>(null);

    // Promote-to-vendor Dialog State
    const [promoteOpen, setPromoteOpen] = useState(false);
    const [promoteSaving, setPromoteSaving] = useState(false);
    const [promote, setPromote] = useState({
        phone: '',
        name: '',
        category: '',
        contact_person: '',
        email: '',
        notes: '',
    });

    // chat_phone → linked vendor directory row. Lets us show "already in
    // directory" and switch the promote button to "open in directory".
    const [vendorByPhone, setVendorByPhone] = useState<Map<string, { id: string; name: string }>>(
        new Map()
    );

    const supabase = createClient();
    const router = useRouter();

    const fetchVendorLinks = useCallback(async () => {
        try {
            const res = await fetch('/api/vendors', { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            const map = new Map<string, { id: string; name: string }>();
            for (const v of (data.vendors ?? []) as Array<{
                id: string;
                name: string;
                chat_phone: string | null;
            }>) {
                if (v.chat_phone) map.set(v.chat_phone, { id: v.id, name: v.name });
            }
            setVendorByPhone(map);
        } catch {
            /* non-fatal — link badges just won't show */
        }
    }, []);

    const sortByRecency = (rows: Contact[]) =>
        [...rows].sort(
            (a, b) =>
                new Date(b.last_message_at ?? 0).getTime() -
                new Date(a.last_message_at ?? 0).getTime()
        );

    const fetchContacts = useCallback(async () => {
        const { data, error } = await supabase
            .from('whatsapp_chats')
            .select(CONTACT_COLUMNS)
            .order('last_message_at', { ascending: false });

        if (error) {
            console.error('Error fetching contacts:', error);
            toast.error('Failed to load contacts');
        } else {
            setContacts((data as unknown as Contact[]) || []);
        }
        setLoading(false);
    }, [supabase]);

    useEffect(() => {
        fetchContacts();
        fetchVendorLinks();
    }, [fetchContacts, fetchVendorLinks]);

    // Realtime: the AI writes lead/vendor fields into whatsapp_chats from the
    // WhatsApp webhook (save_lead_info). Subscribe so Contacts fills in live —
    // no manual refresh. whatsapp_chats is in the supabase_realtime publication
    // (migration 0010); RLS is authenticated-only so the admin receives changes.
    const upsertFromRealtime = useCallback((row: Contact) => {
        setContacts((prev) => {
            const idx = prev.findIndex((c) => c.phone_number === row.phone_number);
            const next =
                idx === -1
                    ? [row, ...prev]
                    : prev.map((c) => (c.phone_number === row.phone_number ? { ...c, ...row } : c));
            return sortByRecency(next);
        });
    }, []);

    const upsertRef = useRef(upsertFromRealtime);
    upsertRef.current = upsertFromRealtime;

    useEffect(() => {
        const channel = supabase
            .channel('contacts-changes')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'whatsapp_chats' },
                (payload) => upsertRef.current(payload.new as Contact)
            )
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'whatsapp_chats' },
                (payload) => upsertRef.current(payload.new as Contact)
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [supabase]);

    const patchLocal = (phone: string, fields: Partial<Contact>) =>
        setContacts((prev) =>
            prev.map((c) => (c.phone_number === phone ? { ...c, ...fields } : c))
        );

    const openEditDialog = (contact: Contact) => {
        setSelectedContact(contact);
        setEditName(contact.contact_name || '');
        // Editing manually means "I'm taking over this name" → default to lock.
        setLockName(true);
        setIsEditOpen(true);
    };

    const openDeleteDialog = (contact: Contact) => {
        setContactToDelete(contact);
        setIsDeleteOpen(true);
    };

    const handleSaveEdit = async () => {
        if (!selectedContact) return;
        const newName = editName.trim() || null;
        try {
            const { error } = await supabase
                .from('whatsapp_chats')
                .update({ contact_name: newName, contact_name_locked: lockName })
                .eq('phone_number', selectedContact.phone_number);
            if (error) throw error;
            patchLocal(selectedContact.phone_number, {
                contact_name: newName,
                contact_name_locked: lockName,
            });
            setIsEditOpen(false);
            toast.success(
                lockName
                    ? 'Nama disimpan & dikunci (AI tidak akan menimpa)'
                    : 'Nama disimpan (AI tetap boleh memperbarui)'
            );
        } catch (error) {
            console.error('Error updating contact:', error);
            toast.error('Failed to update contact name');
        }
    };

    const handleDelete = async () => {
        if (!contactToDelete) return;
        try {
            const { error } = await supabase
                .from('whatsapp_chats')
                .update({ contact_name: null, contact_name_locked: false })
                .eq('phone_number', contactToDelete.phone_number);
            if (error) throw error;
            patchLocal(contactToDelete.phone_number, {
                contact_name: null,
                contact_name_locked: false,
            });
            setIsDeleteOpen(false);
            toast.success('Contact name removed');
        } catch (error) {
            console.error('Error removing contact name:', error);
            toast.error('Failed to remove contact name');
        }
    };

    // Write a classification (no toast) — shared by the manual control and the
    // promote-to-vendor flow so we don't stack two toasts. Locks contact_type so
    // the AI can't override this human decision on the next message.
    const setContactTypeSilent = async (phone: string, type: ContactType) => {
        const { error } = await supabase
            .from('whatsapp_chats')
            .update({ contact_type: type, contact_type_locked: true })
            .eq('phone_number', phone);
        if (error) throw error;
        patchLocal(phone, { contact_type: type });
    };

    // Manual override of the AI's classification.
    const handleSetType = async (phone: string, type: ContactType) => {
        try {
            await setContactTypeSilent(phone, type);
            toast.success(`Ditandai sebagai ${type === 'vendor' ? 'Vendor' : type === 'other' ? 'Lainnya' : 'Klien'}`);
        } catch (error) {
            console.error('Error setting contact type:', error);
            toast.error('Gagal mengubah tipe kontak');
        }
    };

    const openPromote = (c: Contact) => {
        setPromote({
            phone: c.phone_number,
            name: c.contact_name || '',
            category: c.vendor_category || '',
            contact_person: c.contact_name || '',
            email: c.email || '',
            notes: c.vendor_offering || stripAuditLines(c.notes) || '',
        });
        setDetailPhone(null);
        setPromoteOpen(true);
    };

    const handlePromote = async () => {
        if (!promote.name.trim()) {
            toast.error('Nama vendor wajib diisi');
            return;
        }
        if (!promote.category) {
            toast.error('Pilih kategori vendor');
            return;
        }
        setPromoteSaving(true);
        try {
            const res = await fetch('/api/vendors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: promote.name.trim(),
                    category: promote.category,
                    contact_person: promote.contact_person.trim() || null,
                    phone: promote.phone,
                    email: promote.email.trim() || null,
                    notes: promote.notes.trim() || null,
                    chat_phone: promote.phone,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Gagal menyimpan vendor');
            // Make sure the contact is flagged as vendor too (best-effort — the
            // vendor row is already saved, so don't fail the whole action).
            if (promote.phone) {
                try {
                    await setContactTypeSilent(promote.phone, 'vendor');
                } catch {
                    /* non-fatal */
                }
            }
            setPromoteOpen(false);
            fetchVendorLinks();
            toast.success('Tersimpan ke Vendor Management');
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Gagal menyimpan vendor');
        } finally {
            setPromoteSaving(false);
        }
    };

    const q = search.toLowerCase();
    const filteredContacts = contacts.filter((c) => {
        if (typeFilter === 'vendor' && c.contact_type !== 'vendor') return false;
        if (typeFilter === 'lead' && c.contact_type !== 'lead') return false;
        return (
            c.phone_number.includes(search) ||
            (c.contact_name && c.contact_name.toLowerCase().includes(q)) ||
            (c.event_interest && c.event_interest.toLowerCase().includes(q)) ||
            (c.vendor_offering && c.vendor_offering.toLowerCase().includes(q)) ||
            (c.email && c.email.toLowerCase().includes(q))
        );
    });

    const detailContact = detailPhone
        ? contacts.find((c) => c.phone_number === detailPhone) ?? null
        : null;

    const counts = {
        all: contacts.length,
        lead: contacts.filter((c) => c.contact_type === 'lead').length,
        vendor: contacts.filter((c) => c.contact_type === 'vendor').length,
    };

    function formatTime(dateString: string | null) {
        if (!dateString) return '—';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return '—';
        return date.toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    return (
        <div className="flex flex-col h-full bg-white rounded-lg border shadow-sm">
            <div className="p-4 border-b flex flex-wrap items-center justify-between gap-3">
                <Tabs value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
                    <TabsList>
                        <TabsTrigger value="all">Semua ({counts.all})</TabsTrigger>
                        <TabsTrigger value="lead">Klien ({counts.lead})</TabsTrigger>
                        <TabsTrigger value="vendor">Vendor ({counts.vendor})</TabsTrigger>
                    </TabsList>
                </Tabs>
                <div className="relative w-64">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Cari nama, nomor, acara…"
                        className="pl-10"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-gray-700 uppercase bg-gray-50 sticky top-0">
                            <tr>
                                {['Nama', 'Acara / Tawaran', 'Peserta', 'Stage', 'Last Active', 'Aksi'].map((h) => (
                                    <th key={h} className="px-6 py-3">{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {Array.from({ length: 8 }).map((_, i) => (
                                <tr key={i} className="bg-white border-b">
                                    {Array.from({ length: 6 }).map((_, j) => (
                                        <td key={j} className="px-6 py-4">
                                            <Skeleton className="h-4 w-full bg-gray-200" />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : filteredContacts.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">No contacts found</div>
                ) : (
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-gray-700 uppercase bg-gray-50 sticky top-0">
                            <tr>
                                <th className="px-6 py-3">Nama</th>
                                <th className="px-6 py-3">Acara / Tawaran</th>
                                <th className="px-6 py-3">Peserta</th>
                                <th className="px-6 py-3">Stage</th>
                                <th className="px-6 py-3">Last Active</th>
                                <th className="px-6 py-3 text-right">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredContacts.map((contact) => (
                                <tr key={contact.phone_number} className="bg-white border-b hover:bg-gray-50">
                                    <td className="px-6 py-4 font-medium text-gray-900">
                                        <button
                                            type="button"
                                            onClick={() => setDetailPhone(contact.phone_number)}
                                            className="flex items-center gap-2 text-left hover:underline"
                                            title="Lihat detail"
                                        >
                                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                                                {contact.contact_type === 'vendor' ? <Store className="h-4 w-4" /> : <User className="h-4 w-4" />}
                                            </div>
                                            <span className="flex items-center gap-1">
                                                {contact.contact_name || (
                                                    <span className="text-muted-foreground">{contact.phone_number}</span>
                                                )}
                                                {contact.contact_name_locked && (
                                                    <Lock className="h-3 w-3 text-muted-foreground" />
                                                )}
                                                <ContactTypeBadge type={contact.contact_type} />
                                            </span>
                                        </button>
                                    </td>
                                    <td className="px-6 py-4 text-gray-600">
                                        {contact.contact_type === 'vendor'
                                            ? contact.vendor_offering || contact.vendor_category || <span className="text-muted-foreground">—</span>
                                            : contact.event_interest || <span className="text-muted-foreground">—</span>}
                                    </td>
                                    <td className="px-6 py-4 text-gray-600">
                                        {contact.participant_count ? `${contact.participant_count} pax` : <span className="text-muted-foreground">—</span>}
                                    </td>
                                    <td className="px-6 py-4">
                                        {contact.contact_type === 'vendor' ? (
                                            <span className="text-xs text-muted-foreground">—</span>
                                        ) : (
                                            <StageBadge stage={contact.lead_stage} />
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">{formatTime(contact.last_message_at)}</td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <Button variant="ghost" size="icon" onClick={() => openEditDialog(contact)} title="Edit Nama">
                                                <Edit2 className="h-4 w-4 text-gray-500" />
                                            </Button>
                                            <Button variant="ghost" size="icon" onClick={() => openDeleteDialog(contact)} title="Hapus Nama">
                                                <Trash2 className="h-4 w-4 text-red-500" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Detail / CRM card */}
            <Dialog open={!!detailPhone} onOpenChange={(open) => !open && setDetailPhone(null)}>
                <DialogContent className="max-w-lg">
                    {detailContact && (
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <span>{detailContact.contact_name || detailContact.phone_number}</span>
                                    <ContactTypeBadge type={detailContact.contact_type} size="md" />
                                    {detailContact.contact_type !== 'vendor' && <StageBadge stage={detailContact.lead_stage} />}
                                </DialogTitle>
                                <DialogDescription className="flex items-center gap-1.5 text-xs">
                                    {detailContact.contact_name_locked ? (
                                        <><Lock className="h-3 w-3" /> Nama dikunci — AI tidak akan menimpa</>
                                    ) : (
                                        <><Sparkles className="h-3 w-3" /> Nama dikelola otomatis oleh AI</>
                                    )}
                                </DialogDescription>
                            </DialogHeader>

                            {/* Manual classification override */}
                            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                                <Label className="text-xs text-muted-foreground">Tipe kontak</Label>
                                <Select
                                    value={detailContact.contact_type}
                                    onValueChange={(v) => handleSetType(detailContact.phone_number, v as ContactType)}
                                >
                                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="lead">Klien</SelectItem>
                                        <SelectItem value="vendor">Vendor</SelectItem>
                                        <SelectItem value="other">Lainnya</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="grid gap-3 py-2 text-sm">
                                <Field icon={Phone} label="Nomor" value={detailContact.phone_number} />
                                <Field icon={Mail} label="Email" value={detailContact.email} />
                                {detailContact.contact_type === 'vendor' ? (
                                    <>
                                        <Field icon={Tag} label="Kategori" value={detailContact.vendor_category} />
                                        <Field icon={Package} label="Tawaran" value={detailContact.vendor_offering} />
                                    </>
                                ) : (
                                    <>
                                        <Field icon={Tag} label="Jenis acara" value={detailContact.event_interest} />
                                        <Field icon={Users} label="Peserta" value={detailContact.participant_count ? `${detailContact.participant_count} pax` : null} />
                                        <Field icon={MapPin} label="Lokasi" value={detailContact.location_pref} />
                                        <Field icon={CalendarDays} label="Tanggal" value={detailContact.event_date_pref} />
                                        <Field icon={Target} label="Tujuan" value={detailContact.event_goals} />
                                        <Field icon={Wallet} label="Budget" value={detailContact.budget_range} />
                                        <Field icon={UserCheck} label="Ditangani" value={detailContact.assigned_to} />
                                    </>
                                )}
                                <Field icon={Sparkles} label="Sumber" value={detailContact.source} />
                                {stripAuditLines(detailContact.notes) && (
                                    <div className="flex gap-2">
                                        <StickyNote className="h-4 w-4 flex-shrink-0 text-muted-foreground mt-0.5" />
                                        <div className="min-w-0">
                                            <div className="text-xs text-muted-foreground">Catatan</div>
                                            <p className="whitespace-pre-wrap break-words text-gray-700">{stripAuditLines(detailContact.notes)}</p>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <DialogFooter className="gap-2 sm:gap-2">
                                {vendorByPhone.has(detailContact.phone_number) && (
                                    <Badge
                                        variant="outline"
                                        className="mr-auto self-center gap-1 border-emerald-200 bg-emerald-50 text-emerald-700"
                                    >
                                        <Store className="h-3 w-3" /> Di direktori
                                    </Badge>
                                )}
                                <Button variant="outline" onClick={() => { const c = detailContact; setDetailPhone(null); openEditDialog(c); }}>
                                    <Edit2 className="mr-2 h-4 w-4" /> Edit Nama
                                </Button>
                                {vendorByPhone.has(detailContact.phone_number) ? (
                                    <Button
                                        onClick={() => {
                                            const v = vendorByPhone.get(detailContact.phone_number)!;
                                            router.push(`/dashboard/vendors?q=${encodeURIComponent(v.name)}`);
                                        }}
                                    >
                                        <Store className="mr-2 h-4 w-4" /> Buka di direktori
                                    </Button>
                                ) : (
                                    <Button onClick={() => openPromote(detailContact)}>
                                        <Store className="mr-2 h-4 w-4" /> Simpan ke Vendor
                                    </Button>
                                )}
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>

            {/* Promote-to-vendor Dialog */}
            <Dialog open={promoteOpen} onOpenChange={setPromoteOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2"><Store className="h-5 w-5" /> Simpan ke Vendor Management</DialogTitle>
                        <DialogDescription>
                            Salin kontak ini ke direktori vendor. Riwayat chat tetap ada di Contacts.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <div className="space-y-1">
                            <Label htmlFor="v-name">Nama vendor</Label>
                            <Input id="v-name" value={promote.name} onChange={(e) => setPromote((p) => ({ ...p, name: e.target.value }))} placeholder="mis. Kata Rasa Catering" />
                        </div>
                        <div className="space-y-1">
                            <Label>Kategori</Label>
                            <Select value={promote.category} onValueChange={(v) => setPromote((p) => ({ ...p, category: v }))}>
                                <SelectTrigger><SelectValue placeholder="Pilih kategori" /></SelectTrigger>
                                <SelectContent>
                                    {VENDOR_CATEGORIES.map((c) => (
                                        <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="v-cp">Kontak person</Label>
                            <Input id="v-cp" value={promote.contact_person} onChange={(e) => setPromote((p) => ({ ...p, contact_person: e.target.value }))} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <Label htmlFor="v-phone">Nomor</Label>
                                <Input id="v-phone" value={promote.phone} disabled className="bg-muted" />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="v-email">Email</Label>
                                <Input id="v-email" value={promote.email} onChange={(e) => setPromote((p) => ({ ...p, email: e.target.value }))} />
                            </div>
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="v-notes">Catatan</Label>
                            <Input id="v-notes" value={promote.notes} onChange={(e) => setPromote((p) => ({ ...p, notes: e.target.value }))} placeholder="apa yang ditawarkan, harga, dll" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPromoteOpen(false)}>Batal</Button>
                        <Button onClick={handlePromote} disabled={promoteSaving}>
                            {promoteSaving ? 'Menyimpan…' : 'Simpan Vendor'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Edit Dialog */}
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit Nama Kontak</DialogTitle>
                        <DialogDescription>
                            Tambahkan nama yang mudah dikenali. Nama ini muncul di chat & daftar kontak.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="name" className="text-right">Nama</Label>
                            <Input id="name" value={editName} onChange={(e) => setEditName(e.target.value)} className="col-span-3" placeholder="mis. Budi Santoso" />
                        </div>
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="phone" className="text-right">Nomor</Label>
                            <Input id="phone" value={selectedContact?.phone_number || ''} disabled className="col-span-3 bg-muted" />
                        </div>
                        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                            <div className="space-y-0.5">
                                <Label htmlFor="lock" className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Kunci nama</Label>
                                <p className="text-xs text-muted-foreground">
                                    Cegah AI menimpa nama ini di percakapan berikutnya. Matikan untuk membiarkan AI mengelola otomatis.
                                </p>
                            </div>
                            <Switch id="lock" checked={lockName} onCheckedChange={setLockName} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsEditOpen(false)}>Batal</Button>
                        <Button onClick={handleSaveEdit}>Simpan</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Dialog */}
            <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Hapus Nama Kontak</DialogTitle>
                        <DialogDescription>
                            Yakin menghapus nama kontak ini? Riwayat chat tetap tersimpan, dan AI kembali boleh mengisi nama otomatis.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                        <p className="text-sm text-muted-foreground">
                            Nomor: <span className="font-medium text-foreground">{contactToDelete?.phone_number}</span>
                        </p>
                        {contactToDelete?.contact_name && (
                            <p className="text-sm text-muted-foreground">
                                Nama: <span className="font-medium text-foreground">{contactToDelete.contact_name}</span>
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>Batal</Button>
                        <Button variant="destructive" onClick={handleDelete}>Hapus Nama</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function Field({
    icon: Icon,
    label,
    value,
}: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string | null;
}) {
    return (
        <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span className="w-24 flex-shrink-0 text-xs text-muted-foreground">{label}</span>
            <span className="min-w-0 break-words text-gray-800">
                {value || <span className="text-muted-foreground">—</span>}
            </span>
        </div>
    );
}
