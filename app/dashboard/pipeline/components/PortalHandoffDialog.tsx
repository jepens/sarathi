'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
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
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    AlertTriangle,
    Building2,
    Check,
    ExternalLink,
    Loader2,
    Plus,
    Search,
    Link2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { safeRandomUUID, deterministicUuid } from '@/lib/uuid';
import { handoffToPortal } from '../actions';
import { buildProposalTitle, type PortalClient, type HandoffLead } from '@/lib/portal/types';

// The lead shape the dialog needs = the shared brief/identity fields (HandoffLead)
// plus the two Portal-link columns. Extends rather than re-declaring so the shape
// stays in ONE place (types.ts) and can't drift.
export interface PortalHandoffLead extends HandoffLead {
    portal_client_id: string | null;
    portal_last_proposal_url: string | null;
}

interface PortalHandoffDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    lead: PortalHandoffLead;
    /** Called after a successful handoff so the board can refetch the link. */
    onLinked: () => void;
}

type PickMode = 'existing' | 'new';

// Internal-first handoff: from a ready lead, one click → a pre-filled DRAFT
// proposal in the Portal, with the Portal client linked-or-created. The picker
// only appears on the FIRST handoff; afterwards we reuse the stored link.
export function PortalHandoffDialog({ open, onOpenChange, lead, onLinked }: PortalHandoffDialogProps) {
    const alreadyLinked = Boolean(lead.portal_client_id);

    const [mode, setMode] = useState<PickMode>('existing');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<PortalClient[]>([]);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [selected, setSelected] = useState<PortalClient | null>(null);
    const [newName, setNewName] = useState('');
    const [title, setTitle] = useState('');
    const [titleDirty, setTitleDirty] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [doneUrl, setDoneUrl] = useState<string | null>(null);
    // Set when the handoff succeeded at the Portal but the link failed to persist
    // (see actions.ts). Drives a persistent warning banner in the success view.
    const [doneWarning, setDoneWarning] = useState<string | null>(null);

    // The client (Organization) name that drives the default proposal title.
    const effectiveClientName =
        mode === 'new' ? newName : selected?.name ?? lead.contact_name ?? '';

    // Identifies the logical handoff attempt: the chosen Portal client.
    const selectionSig = alreadyLinked
        ? `linked:${lead.portal_client_id}`
        : mode === 'existing'
            ? `existing:${selected?.id ?? ''}`
            : `new:${newName.trim()}`;

    // One idempotency key PER logical attempt, held in a ref (not useMemo, which
    // React may discard). Stable across double-clicks AND retries of the same
    // selection → the Portal dedups them to one proposal; regenerated only when
    // the selection identity changes. Cleared when the dialog (re)opens.
    const idemRef = useRef<{ sig: string; key: string } | null>(null);

    // Reset transient state whenever the dialog (re)opens.
    useEffect(() => {
        if (!open) return;
        setMode('existing');
        setQuery('');
        setResults([]);
        setSearching(false);
        setSearchError(null);
        setSelected(null);
        setNewName(lead.contact_name ?? '');
        setTitleDirty(false);
        setSubmitting(false);
        setDoneUrl(null);
        setDoneWarning(null);
        idemRef.current = null;
    }, [open, lead.contact_name]);

    // Keep the default title in sync with the chosen client until the user edits it.
    useEffect(() => {
        if (!open || titleDirty) return;
        setTitle(buildProposalTitle(lead, effectiveClientName));
    }, [open, titleDirty, lead, effectiveClientName]);

    // Debounced live search of Portal clients (existing mode, first handoff only).
    useEffect(() => {
        if (!open || alreadyLinked || mode !== 'existing') return;
        const q = query.trim();
        if (q.length < 2) {
            setResults([]);
            setSearching(false);
            setSearchError(null);
            return;
        }
        const controller = new AbortController();
        // Gate all state writes on this flag: when a newer query supersedes this
        // effect, cleanup sets active=false so the aborted request's late writes
        // (incl. the finally) can't flip the spinner off under the new search.
        let active = true;
        setSearching(true);
        setSearchError(null);
        const timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/portal/clients?q=${encodeURIComponent(q)}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                if (active) setResults(Array.isArray(data.clients) ? data.clients : []);
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                if (active) {
                    setResults([]);
                    setSearchError(err instanceof Error ? err.message : 'Gagal mencari klien');
                }
            } finally {
                if (active) setSearching(false);
            }
        }, 300);
        return () => {
            active = false;
            controller.abort();
            clearTimeout(timer);
        };
    }, [open, alreadyLinked, mode, query]);

    const canSubmit =
        !submitting &&
        title.trim().length > 0 &&
        (alreadyLinked ||
            (mode === 'existing' && !!selected) ||
            (mode === 'new' && newName.trim().length > 0));

    const handleSubmit = useCallback(async () => {
        if (!canSubmit) return;
        const client = alreadyLinked
            ? { mode: 'existing' as const, clientId: lead.portal_client_id! }
            : mode === 'existing'
                ? { mode: 'existing' as const, clientId: selected!.id }
                : { mode: 'new' as const, name: newName.trim() };

        // Open the destination tab NOW, synchronously inside the click gesture, so
        // strict popup blockers (Safari; Chrome once transient activation lapses on
        // a slow handoff) don't suppress it after the await. NOT 'noopener' here —
        // that returns null and we'd lose the handle; we null `opener` after
        // navigating to keep the same protection.
        const proposalTab = window.open('about:blank', '_blank');

        setSubmitting(true);
        const toastId = toast.loading('Membuat proposal di Portal…');
        try {
            // Reuse the key for the current selection (retry-safe); mint a new one
            // only if the selection changed. First handoff (not yet linked) derives
            // the key DETERMINISTICALLY from phone + selection so two tabs with the
            // same choice collide on ONE key → Portal dedups → a single client. A
            // relinked lead uses a fresh random key so it can spin up many drafts.
            // Generated in-try (via safeRandomUUID, which works over plain HTTP) so
            // any failure surfaces as a toast instead of a silent no-op.
            if (!idemRef.current || idemRef.current.sig !== selectionSig) {
                const key = alreadyLinked
                    ? safeRandomUUID()
                    : deterministicUuid(`${lead.phone_number}::${selectionSig}`);
                idemRef.current = { sig: selectionSig, key };
            }

            const result = await handoffToPortal({
                phone: lead.phone_number,
                idempotencyKey: idemRef.current.key,
                title: title.trim(),
                client,
            });
            if (!result.ok) throw new Error(result.error);

            onLinked();
            // On a persist warning the link was NOT saved, so don't claim "klien
            // tertaut" — the persistent detail lives in the success-view banner.
            if (result.warning) {
                toast.warning('Proposal dibuat, tetapi tautan klien gagal disimpan.', { id: toastId });
            } else {
                toast.success('Proposal Portal dibuat & klien tertaut', { id: toastId });
            }
            setDoneWarning(result.warning ?? null);
            setDoneUrl(result.proposalUrl);
            // Clear submitting so the success view's standard close affordances
            // (Esc / overlay / X) aren't swallowed by the onOpenChange guard.
            setSubmitting(false);
            // Point the pre-opened tab at the draft. If it was blocked anyway, the
            // success view still offers a manual "Buka proposal" button.
            if (proposalTab) {
                proposalTab.opener = null;
                proposalTab.location.href = result.proposalUrl;
            }
        } catch (err) {
            proposalTab?.close();
            toast.error(err instanceof Error ? err.message : 'Gagal handoff ke Portal', {
                id: toastId,
            });
            setSubmitting(false);
        }
    }, [
        canSubmit,
        alreadyLinked,
        lead.portal_client_id,
        lead.phone_number,
        mode,
        selected,
        newName,
        selectionSig,
        title,
        onLinked,
    ]);

    return (
        <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
            <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Buat Proposal di Portal</DialogTitle>
                    <DialogDescription>
                        {doneUrl
                            ? 'Draft proposal berhasil dibuat di Portal.'
                            : alreadyLinked
                                ? 'Lead ini sudah tertaut ke klien Portal — langsung buat draft proposal baru.'
                                : 'Tautkan ke klien Portal (atau buat baru), lalu kita buat draft proposal terisi.'}
                    </DialogDescription>
                </DialogHeader>

                {doneUrl ? (
                    <div className="space-y-4 py-2">
                        {doneWarning ? (
                            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                                <span>{doneWarning}</span>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                                <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                                <span>Klien tertaut & draft proposal siap diisi di Portal.</span>
                            </div>
                        )}
                        <Button asChild className="w-full">
                            <a href={doneUrl} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="mr-2 h-4 w-4" />
                                Buka proposal di Portal
                            </a>
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {/* Recipient summary */}
                        <div className="rounded-md border bg-muted/30 p-3 text-sm">
                            <span className="text-muted-foreground">Lead:</span>{' '}
                            <span className="font-medium">
                                {lead.contact_name ?? lead.phone_number}
                            </span>
                            {lead.event_interest && (
                                <span className="text-muted-foreground"> · {lead.event_interest}</span>
                            )}
                        </div>

                        {/* Picker — only on the first handoff. */}
                        {!alreadyLinked && (
                            <div className="space-y-3">
                                <div className="inline-flex rounded-md border p-0.5 text-sm">
                                    <button
                                        type="button"
                                        onClick={() => setMode('existing')}
                                        className={cn(
                                            'rounded px-3 py-1 transition-colors',
                                            mode === 'existing'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        Cari klien
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setMode('new')}
                                        className={cn(
                                            'rounded px-3 py-1 transition-colors',
                                            mode === 'new'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        Buat klien baru
                                    </button>
                                </div>

                                {mode === 'existing' ? (
                                    <div className="space-y-2">
                                        <div className="relative">
                                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                            <Input
                                                value={query}
                                                onChange={(e) => {
                                                    setQuery(e.target.value);
                                                    setSelected(null);
                                                }}
                                                placeholder="Cari nama klien di Portal…"
                                                className="pl-8"
                                                autoFocus
                                            />
                                            {searching && (
                                                <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                                            )}
                                        </div>

                                        {searchError && (
                                            <p className="text-xs text-rose-500">{searchError}</p>
                                        )}

                                        {selected ? (
                                            <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-2 text-sm">
                                                <Building2 className="h-4 w-4 text-muted-foreground" />
                                                <span className="flex-1 truncate font-medium">
                                                    {selected.name}
                                                </span>
                                                <Check className="h-4 w-4 text-primary" />
                                            </div>
                                        ) : results.length > 0 ? (
                                            <ScrollArea className="max-h-44 rounded-md border">
                                                <div className="p-1">
                                                    {results.map((c) => (
                                                        <button
                                                            key={c.id}
                                                            type="button"
                                                            onClick={() => setSelected(c)}
                                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                                                        >
                                                            <Building2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                                            <span className="truncate">{c.name}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </ScrollArea>
                                        ) : query.trim().length >= 2 && !searching ? (
                                            <p className="text-xs text-muted-foreground">
                                                Tidak ada klien cocok. Coba kata kunci lain atau{' '}
                                                <button
                                                    type="button"
                                                    className="underline"
                                                    onClick={() => setMode('new')}
                                                >
                                                    buat klien baru
                                                </button>
                                                .
                                            </p>
                                        ) : (
                                            <p className="text-xs text-muted-foreground">
                                                Ketik minimal 2 huruf untuk mencari.
                                            </p>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-1.5">
                                        <Label htmlFor="portal-new-name">Nama klien baru (Organisasi)</Label>
                                        <Input
                                            id="portal-new-name"
                                            value={newName}
                                            onChange={(e) => setNewName(e.target.value)}
                                            placeholder="mis. PT Astra"
                                            autoFocus
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Akan dibuat sebagai klien baru di Portal.
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}

                        {alreadyLinked && lead.portal_last_proposal_url && (
                            <a
                                href={lead.portal_last_proposal_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-2 hover:underline"
                            >
                                <Link2 className="h-3.5 w-3.5" />
                                Buka proposal terakhir
                            </a>
                        )}

                        {/* Proposal title */}
                        <div className="space-y-1.5">
                            <Label htmlFor="portal-title">Judul proposal</Label>
                            <Input
                                id="portal-title"
                                value={title}
                                onChange={(e) => {
                                    setTitle(e.target.value);
                                    setTitleDirty(true);
                                }}
                                placeholder="Penawaran — …"
                            />
                        </div>
                    </div>
                )}

                <DialogFooter className="gap-2 sm:gap-0">
                    {doneUrl ? (
                        <Button type="button" onClick={() => onOpenChange(false)}>
                            Selesai
                        </Button>
                    ) : (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                                disabled={submitting}
                            >
                                Batal
                            </Button>
                            <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
                                {submitting ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : alreadyLinked ? (
                                    <Plus className="mr-2 h-4 w-4" />
                                ) : (
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                )}
                                {alreadyLinked ? 'Buat draft proposal' : 'Buat di Portal'}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
