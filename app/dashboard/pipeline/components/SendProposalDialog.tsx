'use client';

import { useState, useRef } from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { stripAuditLines } from '@/lib/proposals/notes';
import { toast } from 'sonner';
import { Loader2, Eye, Send, Upload, FileText, X, Sparkles } from 'lucide-react';

interface SendProposalDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    phoneNumber: string;
    contactName: string | null;
    email: string | null;
    eventInterest: string | null;
    participantCount: number | null;
    locationPref: string | null;
    eventDatePref: string | null;
    eventGoals: string | null;
    budgetRange: string | null;
    notes: string | null;
    source: string | null;
    /** The org's business name (business profile), for the suggested intro. */
    businessName: string;
    onSent: () => void;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface UploadedProposal {
    proposalId: string;
    proposalRef: string;
    filename: string;
    sizeBytes: number;
}

// Admin proposal dialog. The client always supplies the PDF (bespoke design
// from Canva/Figma/etc.) — there is no template-generation path. Before
// sending, the admin reviews/edits an FNA (Form Need Analysis) summary of the
// client's requirements, which is frozen onto the proposals row as an audit of
// the brief the proposal was built against.
export function SendProposalDialog({
    open,
    onOpenChange,
    phoneNumber,
    contactName,
    email,
    eventInterest,
    participantCount,
    locationPref,
    eventDatePref,
    eventGoals,
    budgetRange,
    notes,
    source,
    businessName,
    onSent,
}: SendProposalDialogProps) {
    const suggested = buildSuggestedIntro({
        contactName,
        eventInterest,
        participantCount,
        locationPref,
        businessName,
    });
    const [introNote, setIntroNote] = useState(suggested);
    const [uploaded, setUploaded] = useState<UploadedProposal | null>(null);
    const [uploading, setUploading] = useState(false);
    const [sending, setSending] = useState(false);
    const [generating, setGenerating] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // FNA fields are kept as strings in state (the participant count is coerced
    // to a number server-side by normalizeFnaSnapshot). Pre-filled from the CRM
    // record; admin can correct or fill gaps before sending. `source` rides
    // along read-only — it's part of the snapshot but not something to edit here.
    const [fna, setFna] = useState({
        event_interest: eventInterest ?? '',
        participant_count: participantCount != null ? String(participantCount) : '',
        location_pref: locationPref ?? '',
        event_date_pref: eventDatePref ?? '',
        event_goals: eventGoals ?? '',
        budget_range: budgetRange ?? '',
        notes: stripAuditLines(notes),
        ai_summary: '',
    });

    const setField = (k: keyof typeof fna, v: string) =>
        setFna((f) => ({ ...f, [k]: v }));

    const busy = uploading || sending;

    const handleFilePick = async (file: File) => {
        if (file.type !== 'application/pdf') {
            toast.error('Hanya file PDF yang diterima');
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            toast.error(`File terlalu besar (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
            return;
        }

        setUploading(true);
        const toastId = toast.loading(`Mengupload ${file.name}...`);
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(
                `/api/proposals/${encodeURIComponent(phoneNumber)}/upload`,
                { method: 'POST', body: formData }
            );
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            setUploaded({
                proposalId: data.proposal_id,
                proposalRef: data.proposal_ref,
                filename: data.original_filename ?? file.name,
                sizeBytes: data.size_bytes ?? file.size,
            });
            toast.success(`Uploaded: ${data.proposal_ref}`, { id: toastId });
        } catch (err) {
            console.error('Upload failed', err);
            toast.error(
                err instanceof Error ? err.message : 'Gagal upload PDF',
                { id: toastId }
            );
        } finally {
            setUploading(false);
            // Reset the input so picking the same file again still triggers onChange.
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleGenerateSummary = async () => {
        setGenerating(true);
        const toastId = toast.loading('Membuat ringkasan dari chat...');
        try {
            const res = await fetch(
                `/api/proposals/${encodeURIComponent(phoneNumber)}/fna-summary`,
                { method: 'POST' }
            );
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            setFna((f) => ({ ...f, ai_summary: data.summary }));
            toast.success('Ringkasan FNA dibuat', { id: toastId });
        } catch (err) {
            console.error('FNA summary failed', err);
            toast.error(
                err instanceof Error ? err.message : 'Gagal membuat ringkasan',
                { id: toastId }
            );
        } finally {
            setGenerating(false);
        }
    };

    const handlePreview = () => {
        if (!uploaded) return;
        const url = new URL(
            `/api/proposals/${encodeURIComponent(phoneNumber)}/preview`,
            window.location.origin
        );
        url.searchParams.set('proposal_id', uploaded.proposalId);
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
    };

    const handleSend = async () => {
        if (!email) {
            toast.error('Lead belum punya email — tambahkan dulu lewat chat.');
            return;
        }
        if (!uploaded) {
            toast.error('Upload PDF dulu sebelum kirim');
            return;
        }

        setSending(true);
        const toastId = toast.loading('Mengirim proposal...');
        try {
            const body: Record<string, unknown> = {
                proposal_id: uploaded.proposalId,
                fna_snapshot: {
                    event_interest: fna.event_interest,
                    participant_count: fna.participant_count,
                    location_pref: fna.location_pref,
                    event_date_pref: fna.event_date_pref,
                    event_goals: fna.event_goals,
                    budget_range: fna.budget_range,
                    notes: fna.notes,
                    source: source ?? null,
                    ai_summary: fna.ai_summary,
                },
            };
            if (introNote.trim()) body.intro_note = introNote.trim();

            const res = await fetch(
                `/api/proposals/${encodeURIComponent(phoneNumber)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }
            );
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            if (data.sent) {
                toast.success(
                    `Proposal ${data.proposal_ref} dikirim ke ${email}`,
                    { id: toastId }
                );
            } else {
                toast.warning(
                    `Proposal ${data.proposal_ref} disimpan tapi belum terkirim: ${data.skipped_reason}`,
                    { id: toastId }
                );
            }
            onSent();
            onOpenChange(false);
        } catch (err) {
            console.error('Failed to send proposal', err);
            toast.error(
                err instanceof Error ? err.message : 'Gagal mengirim proposal',
                { id: toastId }
            );
        } finally {
            setSending(false);
        }
    };

    const sendDisabled = busy || !email || !uploaded;

    return (
        <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
            <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Review &amp; Send Proposal</DialogTitle>
                    <DialogDescription>
                        Tinjau kebutuhan klien, lampirkan PDF, lalu kirim ke email klien.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
                        <div>
                            <span className="text-muted-foreground">Kepada:</span>{' '}
                            <span className="font-medium">
                                {contactName ?? phoneNumber}
                            </span>
                            {email ? (
                                <span className="text-muted-foreground"> · {email}</span>
                            ) : (
                                <span className="text-rose-500"> · no email</span>
                            )}
                        </div>
                    </div>

                    {/* FNA — client needs analysis. Internal reference + stored snapshot. */}
                    <div className="space-y-2 rounded-md border p-3">
                        <div className="flex items-center justify-between">
                            <Label className="text-sm font-medium">
                                Ringkasan Kebutuhan Klien (FNA)
                            </Label>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={handleGenerateSummary}
                                disabled={generating || busy}
                            >
                                {generating ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                                )}
                                Tarik ringkasan dari chat
                            </Button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <FnaField
                                label="Jenis acara"
                                value={fna.event_interest}
                                onChange={(v) => setField('event_interest', v)}
                                placeholder="gala dinner"
                                disabled={busy}
                            />
                            <FnaField
                                label="Jumlah peserta"
                                value={fna.participant_count}
                                onChange={(v) =>
                                    setField('participant_count', v.replace(/[^\d]/g, ''))
                                }
                                placeholder="170"
                                inputMode="numeric"
                                disabled={busy}
                            />
                            <FnaField
                                label="Lokasi"
                                value={fna.location_pref}
                                onChange={(v) => setField('location_pref', v)}
                                placeholder="Anyer"
                                disabled={busy}
                            />
                            <FnaField
                                label="Tanggal"
                                value={fna.event_date_pref}
                                onChange={(v) => setField('event_date_pref', v)}
                                placeholder="12-13 Juni"
                                disabled={busy}
                            />
                        </div>
                        <FnaField
                            label="Budget"
                            value={fna.budget_range}
                            onChange={(v) => setField('budget_range', v)}
                            placeholder="belum ditentukan"
                            disabled={busy}
                        />
                        <FnaField
                            label="Tujuan / objektif acara"
                            value={fna.event_goals}
                            onChange={(v) => setField('event_goals', v)}
                            placeholder="memperkuat kolaborasi tim"
                            disabled={busy}
                        />
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">
                                Catatan / kebutuhan khusus
                            </Label>
                            <Textarea
                                value={fna.notes}
                                onChange={(e) => setField('notes', e.target.value)}
                                placeholder="preferensi, kendala, permintaan khusus..."
                                rows={2}
                                disabled={busy}
                                className="text-sm"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">
                                Ringkasan kebutuhan (AI / manual)
                            </Label>
                            <Textarea
                                value={fna.ai_summary}
                                onChange={(e) => setField('ai_summary', e.target.value)}
                                placeholder="Klik 'Tarik ringkasan dari chat' atau tulis manual."
                                rows={4}
                                disabled={busy}
                                className="text-sm"
                            />
                        </div>
                    </div>

                    {/* Upload — the only PDF source. */}
                    <div className="space-y-2">
                        <Label>File PDF proposal</Label>
                        {uploaded ? (
                            <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm">
                                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <p className="truncate font-medium">{uploaded.filename}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {(uploaded.sizeBytes / 1024).toFixed(0)} KB · ref{' '}
                                        {uploaded.proposalRef}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => setUploaded(null)}
                                    disabled={busy}
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/30 p-6 text-center">
                                <Upload className="h-6 w-6 text-muted-foreground" />
                                <div className="text-sm">
                                    <Button
                                        type="button"
                                        variant="link"
                                        className="h-auto p-0 text-sm"
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={uploading}
                                    >
                                        {uploading ? 'Mengupload...' : 'Pilih file PDF'}
                                    </Button>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Max 10 MB · hanya .pdf · dari Canva, Figma, atau desain tim
                                    </p>
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="application/pdf"
                                    className="hidden"
                                    onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (f) void handleFilePick(f);
                                    }}
                                />
                            </div>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="intro_note">Intro note (email body)</Label>
                        <Textarea
                            id="intro_note"
                            value={introNote}
                            onChange={(e) => setIntroNote(e.target.value)}
                            placeholder="Personalised opening untuk email."
                            rows={4}
                            disabled={busy}
                        />
                        <p className="text-xs text-muted-foreground">
                            Kosong → pakai default.
                        </p>
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:gap-0">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handlePreview}
                        disabled={busy || !uploaded}
                    >
                        <Eye className="mr-2 h-4 w-4" />
                        Preview PDF
                    </Button>
                    <Button type="button" onClick={handleSend} disabled={sendDisabled}>
                        {sending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Send className="mr-2 h-4 w-4" />
                        )}
                        Send to {email ?? 'no email'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function FnaField({
    label,
    value,
    onChange,
    placeholder,
    disabled,
    inputMode,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    disabled?: boolean;
    inputMode?: 'text' | 'numeric';
}) {
    return (
        <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                inputMode={inputMode}
                className="h-8 text-sm"
            />
        </div>
    );
}

function buildSuggestedIntro({
    contactName,
    eventInterest,
    participantCount,
    locationPref,
    businessName,
}: {
    contactName: string | null;
    eventInterest: string | null;
    participantCount: number | null;
    locationPref: string | null;
    businessName: string;
}): string {
    const name = contactName ?? 'kak';
    const interest = eventInterest?.trim();
    const pax = participantCount;
    const loc = locationPref?.trim();

    if (interest && pax && loc) {
        return `Halo ${name}, terima kasih sudah ngobrol dengan tim kami soal ${interest} untuk ${pax} peserta di ${loc}. Berikut penawaran awal yang sudah kami siapkan — silakan dilihat di lampiran PDF.`;
    }
    if (interest && pax) {
        return `Halo ${name}, berikut penawaran awal untuk ${interest} dengan ${pax} peserta sesuai obrolan kita kemarin.`;
    }
    if (interest) {
        return `Halo ${name}, berikut penawaran awal untuk acara ${interest} dari ${businessName}.`;
    }
    return '';
}
