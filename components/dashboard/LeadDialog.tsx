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
import {
    leadInputSchema,
    leadFieldsSchema,
    sourceLabel,
    LEAD_SOURCE_OPTIONS,
    LEAD_SOURCE_VALUES,
    LEAD_STAGE_OPTIONS,
    LEAD_STAGE_VALUES,
    type LeadSource,
    type LeadStage,
} from '@/lib/leads/schema';

// The subset of lead fields this dialog can edit (a whatsapp_chats row).
export interface LeadEditData {
    phone_number: string;
    contact_name: string | null;
    email: string | null;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    source: string | null;
    lead_stage: string | null;
    assigned_to: string | null;
    notes: string | null;
}

interface LeadFormState {
    contact_name: string;
    phone_number: string;
    email: string;
    event_interest: string;
    participant_count: string;
    location_pref: string;
    event_date_pref: string;
    event_goals: string;
    budget_range: string;
    source: LeadSource;
    lead_stage: LeadStage;
    assigned_to: string;
    notes: string;
}

const EMPTY_FORM: LeadFormState = {
    contact_name: '',
    phone_number: '',
    email: '',
    event_interest: '',
    participant_count: '',
    location_pref: '',
    event_date_pref: '',
    event_goals: '',
    budget_range: '',
    source: 'manual',
    lead_stage: 'new',
    assigned_to: '',
    notes: '',
};

// Edit validates ONLY the fields the PATCH body actually sends. phone_number
// (the read-only PK) and source (set once at creation) are omitted — otherwise
// a valid existing lead whose phone isn't Indonesian (e.g. a foreign WhatsApp
// number) would be blocked by phone validation and could never be edited.
const leadEditSchema = leadFieldsSchema.omit({ phone_number: true, source: true });

function asSource(s: string | null): LeadSource {
    return s != null && (LEAD_SOURCE_VALUES as readonly string[]).includes(s)
        ? (s as LeadSource)
        : 'manual';
}
function asStage(s: string | null): LeadStage {
    return s != null && (LEAD_STAGE_VALUES as readonly string[]).includes(s)
        ? (s as LeadStage)
        : 'new';
}

interface LeadDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
    /** When set, the dialog edits this lead (PATCH) instead of creating one (POST). */
    leadToEdit?: LeadEditData | null;
}

export function LeadDialog({ open, onOpenChange, onSuccess, leadToEdit }: LeadDialogProps) {
    const isEdit = !!leadToEdit;
    const isSynthetic = !!leadToEdit?.phone_number.startsWith('manual:');

    const [loading, setLoading] = useState(false);
    const [form, setForm] = useState<LeadFormState>(EMPTY_FORM);
    const [errors, setErrors] = useState<Record<string, string>>({});

    // Prefill on (re)open: from the lead in edit mode, blank in create mode.
    useEffect(() => {
        if (leadToEdit) {
            setForm({
                contact_name: leadToEdit.contact_name ?? '',
                phone_number: leadToEdit.phone_number.startsWith('manual:')
                    ? ''
                    : leadToEdit.phone_number,
                email: leadToEdit.email ?? '',
                event_interest: leadToEdit.event_interest ?? '',
                participant_count:
                    leadToEdit.participant_count != null
                        ? String(leadToEdit.participant_count)
                        : '',
                location_pref: leadToEdit.location_pref ?? '',
                event_date_pref: leadToEdit.event_date_pref ?? '',
                event_goals: leadToEdit.event_goals ?? '',
                budget_range: leadToEdit.budget_range ?? '',
                source: asSource(leadToEdit.source),
                lead_stage: asStage(leadToEdit.lead_stage),
                assigned_to: leadToEdit.assigned_to ?? '',
                notes: leadToEdit.notes ?? '',
            });
        } else {
            setForm(EMPTY_FORM);
        }
        setErrors({});
    }, [leadToEdit, open]);

    const set = <K extends keyof LeadFormState>(key: K, value: LeadFormState[K]) =>
        setForm((f) => ({ ...f, [key]: value }));

    const collectErrors = (issues: { path: PropertyKey[]; message: string }[]) => {
        const fieldErrors: Record<string, string> = {};
        for (const issue of issues) {
            const key = String(issue.path[0] ?? '');
            if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
        }
        return fieldErrors;
    };

    const submitCreate = async () => {
        const parsed = leadInputSchema.safeParse(form);
        if (!parsed.success) {
            setErrors(collectErrors(parsed.error.issues));
            toast.error(parsed.error.issues[0]?.message ?? 'Periksa kembali isian form');
            return;
        }
        setErrors({});
        setLoading(true);
        try {
            const res = await fetch('/api/leads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error || 'Gagal menyimpan lead');
            }
            const data = (await res.json()) as { result?: string };
            toast.success(
                data.result === 'created'
                    ? 'Lead ditambahkan ke pipeline'
                    : 'Lead sudah ada — data kosong dilengkapi'
            );
            onSuccess();
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Gagal menyimpan lead');
        } finally {
            setLoading(false);
        }
    };

    const submitEdit = async () => {
        if (!leadToEdit) return;
        // Validate field shapes (email, participant_count) without the
        // "at least one identifier" rule — we're editing an existing row.
        const parsed = leadEditSchema.safeParse(form);
        if (!parsed.success) {
            setErrors(collectErrors(parsed.error.issues));
            toast.error(parsed.error.issues[0]?.message ?? 'Periksa kembali isian form');
            return;
        }
        setErrors({});
        setLoading(true);
        // Build the PATCH body explicitly: blank → null (clears the cell).
        // `source` and `phone_number` are intentionally omitted — source is set
        // once at creation, and the phone is the row's identity (PK).
        const body = {
            contact_name: form.contact_name.trim() || null,
            email: form.email.trim() || null,
            event_interest: form.event_interest.trim() || null,
            participant_count:
                form.participant_count.trim() === '' ? null : Number(form.participant_count),
            location_pref: form.location_pref.trim() || null,
            event_date_pref: form.event_date_pref.trim() || null,
            event_goals: form.event_goals.trim() || null,
            budget_range: form.budget_range.trim() || null,
            lead_stage: form.lead_stage,
            assigned_to: form.assigned_to.trim() || null,
            notes: form.notes.trim() || null,
        };
        try {
            const res = await fetch(
                `/api/leads/${encodeURIComponent(leadToEdit.phone_number)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }
            );
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error || 'Gagal memperbarui lead');
            }
            toast.success('Lead diperbarui');
            onSuccess();
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Gagal memperbarui lead');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (isEdit) submitEdit();
        else submitCreate();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px] max-h-[90dvh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Edit Lead' : 'Tambah Lead'}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    {!isEdit && (
                        <p className="text-xs text-muted-foreground">
                            Minimal isi salah satu: nama, nomor HP, atau email. Jika diisi nomor
                            HP-nya, lead otomatis nyambung saat orang itu chat WhatsApp.
                        </p>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="contact_name">Nama</Label>
                            <Input
                                id="contact_name"
                                value={form.contact_name}
                                onChange={(e) => set('contact_name', e.target.value)}
                                placeholder="Budi Santoso"
                            />
                            {errors.contact_name && (
                                <p className="text-xs text-destructive">{errors.contact_name}</p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="phone_number">Nomor HP / WhatsApp</Label>
                            {isEdit ? (
                                <>
                                    <Input
                                        id="phone_number"
                                        value={isSynthetic ? 'Tanpa nomor' : form.phone_number}
                                        disabled
                                        className="bg-muted"
                                    />
                                    <p className="text-[11px] text-muted-foreground">
                                        Nomor tidak bisa diubah di sini.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Input
                                        id="phone_number"
                                        value={form.phone_number}
                                        onChange={(e) => set('phone_number', e.target.value)}
                                        placeholder="08123456789"
                                        inputMode="tel"
                                    />
                                    {errors.phone_number && (
                                        <p className="text-xs text-destructive">
                                            {errors.phone_number}
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <Input
                                id="email"
                                type="email"
                                value={form.email}
                                onChange={(e) => set('email', e.target.value)}
                                placeholder="budi@email.com"
                            />
                            {errors.email && (
                                <p className="text-xs text-destructive">{errors.email}</p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="participant_count">Jumlah peserta (pax)</Label>
                            <Input
                                id="participant_count"
                                value={form.participant_count}
                                onChange={(e) => set('participant_count', e.target.value)}
                                placeholder="200"
                                inputMode="numeric"
                            />
                            {errors.participant_count && (
                                <p className="text-xs text-destructive">
                                    {errors.participant_count}
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="event_interest">Jenis acara</Label>
                            <Input
                                id="event_interest"
                                value={form.event_interest}
                                onChange={(e) => set('event_interest', e.target.value)}
                                placeholder="Pernikahan, gathering, dll."
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="location_pref">Lokasi</Label>
                            <Input
                                id="location_pref"
                                value={form.location_pref}
                                onChange={(e) => set('location_pref', e.target.value)}
                                placeholder="Bandung"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="event_date_pref">Tanggal acara</Label>
                            <Input
                                id="event_date_pref"
                                value={form.event_date_pref}
                                onChange={(e) => set('event_date_pref', e.target.value)}
                                placeholder="12 Sep 2026"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="budget_range">Budget</Label>
                            <Input
                                id="budget_range"
                                value={form.budget_range}
                                onChange={(e) => set('budget_range', e.target.value)}
                                placeholder="50-75 juta"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="source">Sumber</Label>
                            {isEdit ? (
                                <Input
                                    id="source"
                                    value={sourceLabel(leadToEdit?.source ?? null)}
                                    disabled
                                    className="bg-muted"
                                />
                            ) : (
                                <Select
                                    value={form.source}
                                    onValueChange={(v) => set('source', v as LeadSource)}
                                >
                                    <SelectTrigger id="source">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {LEAD_SOURCE_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="lead_stage">Stage</Label>
                            <Select
                                value={form.lead_stage}
                                onValueChange={(v) => set('lead_stage', v as LeadStage)}
                            >
                                <SelectTrigger id="lead_stage">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {LEAD_STAGE_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="assigned_to">PIC / Sales</Label>
                        <Input
                            id="assigned_to"
                            value={form.assigned_to}
                            onChange={(e) => set('assigned_to', e.target.value)}
                            placeholder="Nama staf yang menangani"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="event_goals">Tujuan acara</Label>
                        <Input
                            id="event_goals"
                            value={form.event_goals}
                            onChange={(e) => set('event_goals', e.target.value)}
                            placeholder="Resepsi 2 sesi, target 300 tamu, dll."
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="notes">Catatan</Label>
                        <Textarea
                            id="notes"
                            value={form.notes}
                            onChange={(e) => set('notes', e.target.value)}
                            placeholder="Konteks tambahan, dari mana lead ini, dll."
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
                            Simpan
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
