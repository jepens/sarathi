'use client';

import { useEffect, useState, useCallback, type DragEvent } from 'react';
import { toast } from 'sonner';
import {
    Loader2,
    User,
    Mail,
    Users,
    MapPin,
    Calendar,
    Target,
    MoreVertical,
    Send,
    UserCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { SendProposalDialog } from './SendProposalDialog';

// Pipeline stages — must match the CHECK constraint on whatsapp_chats.lead_stage
// and the LEAD_STAGES export in lib/ai/tools.ts. Order in this array is the
// left-to-right column order on the board.
const STAGES = [
    { id: 'new', label: 'New', accent: 'border-slate-500/40 bg-slate-500/5' },
    { id: 'qualifying', label: 'Qualifying', accent: 'border-blue-500/40 bg-blue-500/5' },
    { id: 'quoted', label: 'Quoted', accent: 'border-amber-500/40 bg-amber-500/5' },
    { id: 'scheduled', label: 'Scheduled', accent: 'border-purple-500/40 bg-purple-500/5' },
    { id: 'booked', label: 'Booked', accent: 'border-cyan-500/40 bg-cyan-500/5' },
    { id: 'won', label: 'Won', accent: 'border-emerald-500/40 bg-emerald-500/5' },
    { id: 'lost', label: 'Lost', accent: 'border-rose-500/40 bg-rose-500/5' },
] as const;

type StageId = (typeof STAGES)[number]['id'];

interface Lead {
    phone_number: string;
    contact_name: string | null;
    email: string | null;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    lead_stage: StageId | null;
    last_message: string | null;
    last_message_at: string | null;
}

export function PipelineBoard() {
    const [leads, setLeads] = useState<Lead[]>([]);
    const [loading, setLoading] = useState(true);
    const [draggedPhone, setDraggedPhone] = useState<string | null>(null);
    const [dragOverStage, setDragOverStage] = useState<StageId | null>(null);
    const [proposalDialogLead, setProposalDialogLead] = useState<Lead | null>(null);

    const fetchLeads = useCallback(async () => {
        try {
            const res = await fetch('/api/leads', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setLeads(data.leads ?? []);
        } catch (err) {
            console.error('Failed to load leads', err);
            toast.error('Gagal memuat leads');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchLeads();
    }, [fetchLeads]);

    const handoffToMJ = async (phone: string) => {
        const lead = leads.find((l) => l.phone_number === phone);
        if (!lead) return;
        const toastId = toast.loading('Handoff ke MJ...');
        try {
            const res = await fetch(`/api/leads/${encodeURIComponent(phone)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assigned_to: 'MJ' }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            toast.success(`Lead ${lead.contact_name ?? phone} di-assign ke MJ`, {
                id: toastId,
            });
        } catch (err) {
            console.error('Failed to handoff', err);
            toast.error(err instanceof Error ? err.message : 'Gagal handoff', {
                id: toastId,
            });
        }
    };

    // Open the review-and-send dialog for a lead. The actual send happens
    // from inside the dialog after the admin has reviewed the PDF + intro.
    const openProposalDialog = (phone: string) => {
        const lead = leads.find((l) => l.phone_number === phone);
        if (!lead) return;
        if (!lead.email) {
            toast.error(
                'Lead belum punya email. Tambahkan dulu lewat chat atau edit kontak.'
            );
            return;
        }
        setProposalDialogLead(lead);
    };

    // Called by SendProposalDialog after a successful send. The server may
    // or may not have bumped the stage to 'quoted' (it only bumps from
    // null/new/qualifying, never regresses scheduled/booked/won/lost). Refetch
    // is the cheapest way to stay consistent with that server-side decision
    // — leads list is small (<200 rows in practice) so the roundtrip is fine.
    const handleProposalSent = () => {
        fetchLeads();
    };

    const moveLead = async (phone: string, toStage: StageId) => {
        const lead = leads.find((l) => l.phone_number === phone);
        if (!lead) return;
        if (lead.lead_stage === toStage) return;

        // Optimistic update — UI flips immediately, rollback on server error.
        const previous = leads;
        setLeads((cur) =>
            cur.map((l) =>
                l.phone_number === phone ? { ...l, lead_stage: toStage } : l
            )
        );

        try {
            const res = await fetch(`/api/leads/${encodeURIComponent(phone)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lead_stage: toStage }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            toast.success(`Lead dipindah ke ${toStage}`);
        } catch (err) {
            console.error('Failed to move lead', err);
            toast.error(
                err instanceof Error ? err.message : 'Gagal update stage'
            );
            setLeads(previous);
        }
    };

    const handleDragStart = (e: DragEvent<HTMLDivElement>, phone: string) => {
        setDraggedPhone(phone);
        e.dataTransfer.effectAllowed = 'move';
        // Setting data is required for Firefox to fire drop events.
        e.dataTransfer.setData('text/plain', phone);
    };

    const handleDragEnd = () => {
        setDraggedPhone(null);
        setDragOverStage(null);
    };

    const handleDragOver = (e: DragEvent<HTMLDivElement>, stage: StageId) => {
        e.preventDefault(); // required to allow drop
        e.dataTransfer.dropEffect = 'move';
        if (dragOverStage !== stage) setDragOverStage(stage);
    };

    const handleDrop = (e: DragEvent<HTMLDivElement>, stage: StageId) => {
        e.preventDefault();
        const phone = draggedPhone ?? e.dataTransfer.getData('text/plain');
        setDraggedPhone(null);
        setDragOverStage(null);
        if (phone) moveLead(phone, stage);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const leadsByStage = (stage: StageId) =>
        leads.filter((l) => (l.lead_stage ?? 'new') === stage);
    const unstaged = leads.filter((l) => !l.lead_stage);

    return (
        <div className="h-full overflow-x-auto pb-4">
            <div className="flex gap-4 h-full min-w-max">
                {STAGES.map((stage) => {
                    const stageLeads = leadsByStage(stage.id);
                    const showUnstagedHere = stage.id === 'new' && unstaged.length > 0;
                    const items = showUnstagedHere
                        ? [...unstaged, ...stageLeads.filter((l) => l.lead_stage === 'new')]
                        : stageLeads;
                    return (
                        <div
                            key={stage.id}
                            className={cn(
                                'w-72 flex-shrink-0 rounded-lg border bg-card flex flex-col transition-colors',
                                stage.accent,
                                dragOverStage === stage.id && 'ring-2 ring-primary'
                            )}
                            onDragOver={(e) => handleDragOver(e, stage.id)}
                            onDrop={(e) => handleDrop(e, stage.id)}
                        >
                            <div className="px-3 py-2 border-b flex items-center justify-between sticky top-0 bg-card/95 backdrop-blur z-10 rounded-t-lg">
                                <h3 className="font-medium text-sm">{stage.label}</h3>
                                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                                    {items.length}
                                </span>
                            </div>
                            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                {items.length === 0 ? (
                                    <div className="text-xs text-muted-foreground text-center py-8 select-none">
                                        Drop di sini
                                    </div>
                                ) : (
                                    items.map((lead) => (
                                        <LeadCard
                                            key={lead.phone_number}
                                            lead={lead}
                                            isDragging={draggedPhone === lead.phone_number}
                                            onDragStart={(e) => handleDragStart(e, lead.phone_number)}
                                            onDragEnd={handleDragEnd}
                                            onSendProposal={() => openProposalDialog(lead.phone_number)}
                                            onHandoff={() => handoffToMJ(lead.phone_number)}
                                            onMoveStage={(stage) => moveLead(lead.phone_number, stage)}
                                        />
                                    ))
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {proposalDialogLead && (
                <SendProposalDialog
                    open={true}
                    onOpenChange={(o) => {
                        if (!o) setProposalDialogLead(null);
                    }}
                    phoneNumber={proposalDialogLead.phone_number}
                    contactName={proposalDialogLead.contact_name}
                    email={proposalDialogLead.email}
                    eventInterest={proposalDialogLead.event_interest}
                    participantCount={proposalDialogLead.participant_count}
                    locationPref={proposalDialogLead.location_pref}
                    onSent={handleProposalSent}
                />
            )}
        </div>
    );
}

function LeadCard({
    lead,
    isDragging,
    onDragStart,
    onDragEnd,
    onSendProposal,
    onHandoff,
    onMoveStage,
}: {
    lead: Lead;
    isDragging: boolean;
    onDragStart: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    onSendProposal: () => void;
    onHandoff: () => void;
    onMoveStage: (stage: StageId) => void;
}) {
    const displayName = lead.contact_name || lead.phone_number;

    return (
        <div
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            className={cn(
                'rounded-md border bg-background p-3 text-sm cursor-grab active:cursor-grabbing hover:shadow-sm transition-all',
                isDragging && 'opacity-50'
            )}
        >
            <div className="flex items-center gap-2 mb-2">
                <User className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <span className="font-medium truncate flex-1">{displayName}</span>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 -mr-1"
                            onClick={(e) => e.stopPropagation()}
                            // Disable drag while the menu trigger is pressed —
                            // otherwise mousedown starts a drag and the menu
                            // never opens.
                            onPointerDown={(e) => e.stopPropagation()}
                        >
                            <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="end"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <DropdownMenuItem onClick={onSendProposal} disabled={!lead.email}>
                            <Send className="mr-2 h-3.5 w-3.5" />
                            Send Proposal{!lead.email && ' (no email)'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onHandoff}>
                            <UserCheck className="mr-2 h-3.5 w-3.5" />
                            Handoff to MJ
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {STAGES.filter((s) => s.id !== lead.lead_stage).map((s) => (
                            <DropdownMenuItem
                                key={s.id}
                                onClick={() => onMoveStage(s.id)}
                            >
                                <UserCheck className="mr-2 h-3.5 w-3.5" />
                                Move to {s.label}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {lead.event_interest && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Target className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{lead.event_interest}</span>
                </div>
            )}
            {lead.participant_count !== null && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Users className="h-3 w-3 flex-shrink-0" />
                    <span>{lead.participant_count} pax</span>
                </div>
            )}
            {lead.location_pref && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <MapPin className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{lead.location_pref}</span>
                </div>
            )}
            {lead.event_date_pref && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Calendar className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{lead.event_date_pref}</span>
                </div>
            )}
            {lead.email && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Mail className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{lead.email}</span>
                </div>
            )}
        </div>
    );
}
