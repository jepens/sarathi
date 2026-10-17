'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useCurrentOrgId } from '@/components/current-org-provider';
import { useOrgRefetch } from '@/components/realtime/org-realtime-provider';
import { Input } from '@/components/ui/input';
import { Search, Clock, Store, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ContactTypeBadge } from '@/components/dashboard/ContactTypeBadge';
import { LabelBadge } from '@/components/dashboard/LabelBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { sortLabels, type Label } from '@/lib/labels';

interface Chat {
    phone_number: string;
    contact_name: string | null;
    contact_type: string | null;
    last_message: string;
    last_message_at: string;
    last_inbound_at: string | null;
    unread_count: number;
}

const WINDOW_MS = 24 * 60 * 60 * 1000; // Meta 24-hour customer service window
const LABEL_TABLES = ['labels', 'chat_labels'] as const;

// Returns true when free-form replies are blocked by Meta — i.e. the customer
// either never messaged us (no window ever opened) or last replied >24h ago.
// In both cases the admin must use a template message (code 131047).
function isWindowExpired(lastInboundAt: string | null): boolean {
    if (!lastInboundAt) return true;
    return Date.now() - new Date(lastInboundAt).getTime() > WINDOW_MS;
}

// "Needs reply" = the last message in the thread was from the customer and we
// haven't answered yet. The webhook stamps last_message_at == last_inbound_at on
// every inbound; outbound sends advance last_message_at only. So if the two are
// equal (last activity was inbound) the customer is waiting on us.
function needsReply(chat: { last_message_at: string | null; last_inbound_at: string | null }): boolean {
    if (!chat.last_inbound_at || !chat.last_message_at) return false;
    return new Date(chat.last_message_at).getTime() <= new Date(chat.last_inbound_at).getTime();
}

interface ChatListProps {
    selectedPhone: string | null;
    onSelect: (phone: string) => void;
}

export function ChatList({ selectedPhone, onSelect }: ChatListProps) {
    const [chats, setChats] = useState<Chat[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    // Labels: the org-wide palette + a phone_number -> Label[] map for the chips,
    // and the currently-selected filter (null = show all).
    const [labels, setLabels] = useState<Label[]>([]);
    const [labelsByPhone, setLabelsByPhone] = useState<Map<string, Label[]>>(new Map());
    const [activeLabelId, setActiveLabelId] = useState<string | null>(null);
    const supabase = createClient();
    // The org of the tab's live channel: every read below is scoped to it
    // (RLS admits the member's orgs; this keeps lists and events in step).
    const orgId = useCurrentOrgId();

    const fetchChats = useCallback(async () => {
        if (!orgId) {
            setLoading(false);
            return;
        }
        const { data, error } = await supabase
            .from('whatsapp_chats')
            // Only conversations that actually exist. Manually added / imported
            // leads have last_message_at = null until they message us, so they
            // stay out of the Inbox (they live in Pipeline / Contacts instead).
            .select('*')
            .eq('org_id', orgId)
            .not('last_message_at', 'is', null)
            .order('last_message_at', { ascending: false });

        if (error) {
            console.error('Error fetching chats:', error);
        } else {
            setChats(data || []);
        }
        setLoading(false);
    }, [supabase, orgId]);

    const fetchLabelData = useCallback(async () => {
        if (!orgId) return;
        // Labels are few — one query. Assignments scale with chats × labels and
        // can exceed PostgREST's default 1000-row cap; page through them so the
        // chips + filter stay complete instead of silently truncating (a dropped
        // assignment would make a labeled chat vanish from its filter).
        const labelsRes = await supabase.from('labels').select('id, name, color').eq('org_id', orgId);
        const sorted = sortLabels(labelsRes.data ?? []);
        setLabels(sorted);
        const byId = new Map(sorted.map((l) => [l.id, l] as const));

        const byPhone = new Map<string, Label[]>();
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase
                .from('chat_labels')
                .select('phone_number, label_id')
                .eq('org_id', orgId)
                .range(from, from + PAGE - 1);
            if (error || !data) break;
            for (const row of data) {
                const lbl = byId.get(row.label_id as string);
                if (!lbl) continue; // assignment to a since-deleted label
                const arr = byPhone.get(row.phone_number as string);
                if (arr) arr.push(lbl);
                else byPhone.set(row.phone_number as string, [lbl]);
            }
            if (data.length < PAGE) break;
        }
        // Stable per-row order (by name) regardless of assignment insert order.
        for (const [phone, arr] of byPhone) byPhone.set(phone, sortLabels(arr));
        setLabelsByPhone(byPhone);
    }, [supabase, orgId]);

    useEffect(() => {
        const load = async () => {
            await Promise.all([fetchChats(), fetchLabelData()]);
        };
        load();

        // Polling fallback - refresh every 30 seconds
        const pollInterval = setInterval(() => {
            fetchChats();
            fetchLabelData();
        }, 30000);

        return () => {
            clearInterval(pollInterval);
        };
    }, [fetchChats, fetchLabelData]);

    // Live: chats + labels + assignments of the org, from the org Realtime bus
    // (coalesced refetch on every change and every RESYNC).
    useOrgRefetch('whatsapp_chats', fetchChats);
    useOrgRefetch(LABEL_TABLES, fetchLabelData);

    // Derive (don't store) the effective filter: a selection pointing at a
    // since-deleted label is treated as "show all", so we never need a
    // setState-in-effect to reconcile it.
    const effectiveLabelId =
        activeLabelId && labels.some((l) => l.id === activeLabelId) ? activeLabelId : null;

    const q = search.toLowerCase();
    const filteredChats = chats.filter((chat) => {
        if (effectiveLabelId) {
            const rowLabels = labelsByPhone.get(chat.phone_number);
            if (!rowLabels || !rowLabels.some((l) => l.id === effectiveLabelId)) return false;
        }
        return (
            chat.phone_number.includes(search) ||
            (chat.contact_name && chat.contact_name.toLowerCase().includes(q)) ||
            chat.last_message?.toLowerCase().includes(q)
        );
    });

    function formatTime(dateString: string) {
        const date = new Date(dateString);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();

        if (isToday) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    return (
        <div className="flex flex-col h-full bg-[var(--wa-list)]">
            <div className="p-3 border-b bg-[var(--wa-panel)] flex-shrink-0">
                <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--wa-text-muted)]" />
                    <Input
                        placeholder="Search or start new chat"
                        className="pl-10 bg-[var(--wa-search)] border-none focus-visible:ring-1 rounded-lg text-[var(--wa-text)] placeholder:text-[var(--wa-text-muted)]"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {labels.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto border-b bg-[var(--wa-panel)] px-3 py-2 flex-shrink-0">
                    {labels.map((l) => {
                        const active = effectiveLabelId === l.id;
                        return (
                            <button
                                key={l.id}
                                type="button"
                                onClick={() => setActiveLabelId(active ? null : l.id)}
                                aria-pressed={active}
                                className={cn(
                                    'shrink-0 rounded-full transition',
                                    active
                                        ? 'ring-2 ring-emerald-500'
                                        : effectiveLabelId
                                          ? 'opacity-50 hover:opacity-100'
                                          : 'hover:opacity-80',
                                )}
                            >
                                <LabelBadge label={l} size="xs" />
                            </button>
                        );
                    })}
                    {effectiveLabelId && (
                        <button
                            type="button"
                            onClick={() => setActiveLabelId(null)}
                            className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-[var(--wa-text-muted)] hover:text-[var(--wa-text)]"
                        >
                            <X className="h-3 w-3" />
                            Hapus filter
                        </button>
                    )}
                </div>
            )}

            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="divide-y divide-border/40">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="flex items-center gap-3 p-3">
                                <Skeleton className="h-12 w-12 shrink-0 rounded-full bg-[var(--wa-avatar)]" />
                                <div className="flex-1 space-y-2">
                                    <Skeleton className="h-3.5 w-1/3 rounded bg-[var(--wa-avatar)]" />
                                    <Skeleton className="h-3 w-2/3 rounded bg-[var(--wa-avatar)]" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : filteredChats.length === 0 ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">No chats found</div>
                ) : (
                    <div>
                        {filteredChats.map((chat) => {
                            const reply = needsReply(chat);
                            return (
                            <button
                                key={chat.phone_number}
                                onClick={() => onSelect(chat.phone_number)}
                                className={cn(
                                    "flex items-center gap-3 p-3 border-b border-border/40 text-left hover:bg-[var(--wa-hover)] transition-colors w-full",
                                    selectedPhone === chat.phone_number && "bg-[var(--wa-selected)]"
                                )}
                            >
                                <div className="h-12 w-12 rounded-full bg-[var(--wa-avatar)] flex items-center justify-center shrink-0">
                                    {chat.contact_type === 'vendor' ? (
                                        <Store className="w-6 h-6 text-orange-500" />
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-[var(--wa-icon)]">
                                            <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clipRule="evenodd" />
                                        </svg>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-center mb-1 gap-2">
                                        <span className="flex items-center gap-1.5 min-w-0">
                                            <span className="font-medium text-[15px] text-[var(--wa-text)] truncate min-w-0">
                                                {chat.contact_name || chat.phone_number}
                                            </span>
                                            <ContactTypeBadge type={chat.contact_type} className="shrink-0" />
                                        </span>
                                        <span className="flex items-center gap-1 shrink-0">
                                            {reply && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-label="Belum dibalas" />}
                                            <span className={cn("text-[12px]", reply ? "text-emerald-600 font-semibold" : "text-[var(--wa-text-muted)]")}>
                                                {formatTime(chat.last_message_at)}
                                            </span>
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <p className={cn("text-[13px] truncate leading-5", reply ? "text-[var(--wa-text)] font-medium" : "text-[var(--wa-text-muted)]")}>
                                            {chat.last_message}
                                        </p>
                                        <span className="flex shrink-0 items-center gap-1">
                                            {isWindowExpired(chat.last_inbound_at) && (
                                                <span
                                                    title="Lebih dari 24 jam sejak pesan terakhir customer. Balasan biasa akan ditolak Meta (kode 131047) — pakai template message."
                                                    className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 text-[10px] font-medium leading-none dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30"
                                                >
                                                    <Clock className="h-2.5 w-2.5" />
                                                    Perlu template
                                                </span>
                                            )}
                                            {/* Unread badge — hidden for the open chat (it's being read). */}
                                            {chat.unread_count > 0 && chat.phone_number !== selectedPhone && (
                                                <span
                                                    className="inline-flex min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white"
                                                    aria-label={`${chat.unread_count} pesan belum dibaca`}
                                                >
                                                    {chat.unread_count > 99 ? '99+' : chat.unread_count}
                                                </span>
                                            )}
                                        </span>
                                    </div>
                                    {(() => {
                                        const rowLabels = labelsByPhone.get(chat.phone_number);
                                        if (!rowLabels || rowLabels.length === 0) return null;
                                        return (
                                            <div className="mt-1 flex items-center gap-1 overflow-hidden">
                                                {rowLabels.slice(0, 3).map((l) => (
                                                    <LabelBadge key={l.id} label={l} size="xs" className="max-w-28" />
                                                ))}
                                                {rowLabels.length > 3 && (
                                                    <span className="text-[10px] font-medium text-[var(--wa-text-muted)]">
                                                        +{rowLabels.length - 3}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })()}
                                </div>
                            </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
