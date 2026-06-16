'use client';

import { useEffect, useState, useCallback } from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { stripAuditLines } from '@/lib/proposals/notes';
import { toast } from 'sonner';
import {
    Loader2,
    Eye,
    ChevronDown,
    ChevronRight,
    CheckCircle2,
    AlertTriangle,
} from 'lucide-react';

interface FnaSnapshot {
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    notes: string | null;
    source: string | null;
    ai_summary: string | null;
    captured_at?: string | null;
}

interface ProposalRow {
    id: string;
    proposal_ref: string;
    source: 'generated' | 'uploaded';
    file_path: string | null;
    intro_note: string | null;
    sent_at: string | null;
    sent_to_email: string | null;
    email_provider_id: string | null;
    skipped_reason: string | null;
    created_at: string;
    fna_snapshot: FnaSnapshot | null;
}

interface ProposalHistoryDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    phoneNumber: string;
    contactName: string | null;
}

export function ProposalHistoryDialog({
    open,
    onOpenChange,
    phoneNumber,
    contactName,
}: ProposalHistoryDialogProps) {
    const [proposals, setProposals] = useState<ProposalRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<string | null>(null);

    const fetchProposals = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(
                `/api/proposals/${encodeURIComponent(phoneNumber)}`,
                { cache: 'no-store' }
            );
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            setProposals(data.proposals ?? []);
        } catch (err) {
            console.error('Failed to load proposals', err);
            toast.error(
                err instanceof Error ? err.message : 'Gagal memuat riwayat proposal'
            );
        } finally {
            setLoading(false);
        }
    }, [phoneNumber]);

    useEffect(() => {
        if (open) fetchProposals();
    }, [open, fetchProposals]);

    const openPdf = (id: string) => {
        const url = new URL(
            `/api/proposals/${encodeURIComponent(phoneNumber)}/preview`,
            window.location.origin
        );
        url.searchParams.set('proposal_id', id);
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>Riwayat Proposal</DialogTitle>
                    <DialogDescription>{contactName ?? phoneNumber}</DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : proposals.length === 0 ? (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                        Belum ada proposal yang dikirim ke lead ini.
                    </div>
                ) : (
                    <ScrollArea className="flex-1 -mx-1 px-1">
                        <div className="space-y-2">
                            {proposals.map((p) => {
                                const isOpen = expanded === p.id;
                                const emailed = !p.skipped_reason;
                                const fna = p.fna_snapshot;
                                return (
                                    <div key={p.id} className="rounded-md border bg-card">
                                        <button
                                            type="button"
                                            onClick={() => setExpanded(isOpen ? null : p.id)}
                                            className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/40 rounded-md transition-colors"
                                        >
                                            {isOpen ? (
                                                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-sm truncate">
                                                        {p.proposal_ref}
                                                    </span>
                                                    {emailed ? (
                                                        <Badge
                                                            variant="outline"
                                                            className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-700"
                                                        >
                                                            <CheckCircle2 className="h-3 w-3" />
                                                            Terkirim
                                                        </Badge>
                                                    ) : (
                                                        <Badge
                                                            variant="outline"
                                                            className="gap-1 border-amber-200 bg-amber-50 text-amber-700"
                                                        >
                                                            <AlertTriangle className="h-3 w-3" />
                                                            Belum terkirim
                                                        </Badge>
                                                    )}
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                                    {formatDateTime(p.sent_at)}
                                                    {p.sent_to_email ? ` · ${p.sent_to_email}` : ''}
                                                </p>
                                            </div>
                                        </button>

                                        {isOpen && (
                                            <div className="border-t px-3 py-3 space-y-3">
                                                {!emailed && p.skipped_reason && (
                                                    <p className="text-xs text-amber-700">
                                                        Email di-skip: {p.skipped_reason}
                                                    </p>
                                                )}

                                                {fna ? (
                                                    <div className="space-y-2">
                                                        <p className="text-xs font-medium text-muted-foreground">
                                                            Kebutuhan klien (FNA)
                                                        </p>
                                                        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                                                            <FnaRow label="Jenis acara" value={fna.event_interest} />
                                                            <FnaRow
                                                                label="Peserta"
                                                                value={
                                                                    fna.participant_count != null
                                                                        ? `${fna.participant_count} pax`
                                                                        : null
                                                                }
                                                            />
                                                            <FnaRow label="Lokasi" value={fna.location_pref} />
                                                            <FnaRow label="Tanggal" value={fna.event_date_pref} />
                                                            <FnaRow label="Budget" value={fna.budget_range} />
                                                            <FnaRow label="Tujuan" value={fna.event_goals} />
                                                        </dl>
                                                        {stripAuditLines(fna.notes) && (
                                                            <DetailBlock
                                                                label="Catatan"
                                                                value={stripAuditLines(fna.notes)}
                                                            />
                                                        )}
                                                        {fna.ai_summary && (
                                                            <DetailBlock label="Ringkasan" value={fna.ai_summary} />
                                                        )}
                                                    </div>
                                                ) : (
                                                    <p className="text-xs text-muted-foreground italic">
                                                        Tidak ada snapshot FNA untuk proposal ini.
                                                    </p>
                                                )}

                                                {p.intro_note && (
                                                    <DetailBlock label="Intro note (email)" value={p.intro_note} />
                                                )}

                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => openPdf(p.id)}
                                                >
                                                    <Eye className="mr-2 h-3.5 w-3.5" />
                                                    Lihat PDF
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </ScrollArea>
                )}
            </DialogContent>
        </Dialog>
    );
}

function FnaRow({ label, value }: { label: string; value: string | null }) {
    return (
        <div>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={value ? 'text-foreground' : 'text-muted-foreground italic'}>
                {value || '—'}
            </dd>
        </div>
    );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
    return (
        <div className="space-y-0.5">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-xs whitespace-pre-wrap rounded bg-muted/40 p-2 leading-relaxed">
                {value}
            </p>
        </div>
    );
}

function formatDateTime(d: string | null): string {
    if (!d) return '—';
    return new Date(d).toLocaleString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}
