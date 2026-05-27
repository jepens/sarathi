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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import { Loader2, Eye, Send, Upload, FileText, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SendProposalDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    phoneNumber: string;
    contactName: string | null;
    email: string | null;
    eventInterest: string | null;
    participantCount: number | null;
    locationPref: string | null;
    onSent: () => void;
}

type Mode = 'generated' | 'uploaded';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface UploadedProposal {
    proposalId: string;
    proposalRef: string;
    filename: string;
    sizeBytes: number;
}

// Admin-driven proposal review dialog. Two modes:
//   - 'generated' (default): backend renders ProposalDocument with the
//     intro_note. Admin previews + sends.
//   - 'uploaded': admin picks a PDF, it's uploaded to Storage and a
//     proposals row is created with sent_at=null. Admin previews (fetches
//     from Storage) + sends (attaches that file). The intro_note still
//     applies to the email body in both modes.
export function SendProposalDialog({
    open,
    onOpenChange,
    phoneNumber,
    contactName,
    email,
    eventInterest,
    participantCount,
    locationPref,
    onSent,
}: SendProposalDialogProps) {
    const suggested = buildSuggestedIntro({
        contactName,
        eventInterest,
        participantCount,
        locationPref,
    });
    const [introNote, setIntroNote] = useState(suggested);
    const [mode, setMode] = useState<Mode>('generated');
    const [uploaded, setUploaded] = useState<UploadedProposal | null>(null);
    const [uploading, setUploading] = useState(false);
    const [sending, setSending] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

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

    const handlePreview = () => {
        const url = new URL(
            `/api/proposals/${encodeURIComponent(phoneNumber)}/preview`,
            window.location.origin
        );
        if (mode === 'uploaded' && uploaded) {
            url.searchParams.set('proposal_id', uploaded.proposalId);
        } else if (introNote.trim()) {
            url.searchParams.set('intro_note', introNote.trim());
        }
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
    };

    const handleSend = async () => {
        if (!email) {
            toast.error('Lead belum punya email — tambahkan dulu lewat chat.');
            return;
        }
        if (mode === 'uploaded' && !uploaded) {
            toast.error('Upload PDF dulu sebelum kirim');
            return;
        }

        setSending(true);
        const toastId = toast.loading('Mengirim proposal...');
        try {
            const body: Record<string, string> = {};
            if (introNote.trim()) body.intro_note = introNote.trim();
            if (mode === 'uploaded' && uploaded) body.proposal_id = uploaded.proposalId;

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
                    `Proposal ${data.proposal_ref} digenerate tapi belum terkirim: ${data.skipped_reason}`,
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

    const sendDisabled =
        busy || !email || (mode === 'uploaded' && !uploaded);

    return (
        <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Review &amp; Send Proposal</DialogTitle>
                    <DialogDescription>
                        Tinjau PDF dan edit intro note sebelum dikirim ke klien.
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
                        {(eventInterest || participantCount || locationPref) && (
                            <div className="text-xs text-muted-foreground">
                                {[
                                    eventInterest,
                                    participantCount ? `${participantCount} pax` : null,
                                    locationPref,
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </div>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label>Sumber PDF</Label>
                        <RadioGroup
                            value={mode}
                            onValueChange={(v) => setMode(v as Mode)}
                            className="grid grid-cols-1 gap-2"
                        >
                            <Label
                                htmlFor="mode-generated"
                                className={cn(
                                    'flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/40 transition-colors',
                                    mode === 'generated' && 'border-primary bg-primary/5'
                                )}
                            >
                                <RadioGroupItem
                                    value="generated"
                                    id="mode-generated"
                                    className="mt-0.5"
                                />
                                <div className="space-y-0.5">
                                    <p className="text-sm font-medium">Generate dari template</p>
                                    <p className="text-xs text-muted-foreground">
                                        Pakai data lead + paket rekomendasi dari katalog.
                                    </p>
                                </div>
                            </Label>

                            <Label
                                htmlFor="mode-uploaded"
                                className={cn(
                                    'flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/40 transition-colors',
                                    mode === 'uploaded' && 'border-primary bg-primary/5'
                                )}
                            >
                                <RadioGroupItem
                                    value="uploaded"
                                    id="mode-uploaded"
                                    className="mt-0.5"
                                />
                                <div className="space-y-0.5 flex-1">
                                    <p className="text-sm font-medium">Upload PDF custom</p>
                                    <p className="text-xs text-muted-foreground">
                                        Pakai PDF bespoke dari Canva, Figma, atau hasil design tim.
                                    </p>
                                </div>
                            </Label>
                        </RadioGroup>
                    </div>

                    {mode === 'uploaded' && (
                        <div className="space-y-2">
                            <Label>File PDF</Label>
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
                                <div
                                    className="flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/30 p-6 text-center"
                                >
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
                                            Max 10 MB · hanya .pdf
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
                    )}

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
                            Kosong → pakai default. Berlaku untuk kedua mode.
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
                        disabled={busy || (mode === 'uploaded' && !uploaded)}
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

function buildSuggestedIntro({
    contactName,
    eventInterest,
    participantCount,
    locationPref,
}: {
    contactName: string | null;
    eventInterest: string | null;
    participantCount: number | null;
    locationPref: string | null;
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
        return `Halo ${name}, berikut penawaran awal untuk acara ${interest} dari Sailendra Organizer.`;
    }
    return '';
}
