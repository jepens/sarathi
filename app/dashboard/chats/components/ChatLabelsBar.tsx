'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useCurrentOrgId } from '@/components/current-org-provider';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuCheckboxItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Tag, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { LabelBadge } from '@/components/dashboard/LabelBadge';
import { labelColor, sortLabels, type Label } from '@/lib/labels';

// The label strip under the chat header: shows the chats's assigned labels (with
// a quick "×" to detach) and a 🏷️ dropdown to toggle any label on/off. Self
// contained — it owns its own fetch + realtime so ChatWindow only drops it in.
export function ChatLabelsBar({ phoneNumber }: { phoneNumber: string }) {
    const supabase = createClient();
    // Explicit org: chat_labels' key is (org_id, phone_number, label_id), so
    // reads, deletes and the upsert all target this org's rows.
    const orgId = useCurrentOrgId();
    const [labels, setLabels] = useState<Label[]>([]);
    const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());

    // Always the phone currently on screen. Guards against an out-of-order
    // fetchAssignments (a slow request for a previous chat resolving after we've
    // switched) writing the wrong chat's labels into this shared, non-remounted
    // component.
    const phoneRef = useRef(phoneNumber);
    phoneRef.current = phoneNumber;

    const fetchLabels = useCallback(async () => {
        if (!orgId) return;
        const { data, error } = await supabase
            .from('labels')
            .select('id, name, color')
            .eq('org_id', orgId);
        if (!error) setLabels(sortLabels(data ?? []));
    }, [supabase, orgId]);

    const fetchAssignments = useCallback(async () => {
        if (!orgId) return;
        const { data, error } = await supabase
            .from('chat_labels')
            .select('label_id')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber);
        if (phoneRef.current !== phoneNumber) return; // a newer chat is open — drop this stale result
        if (!error) setAssignedIds(new Set((data ?? []).map((r) => r.label_id as string)));
    }, [supabase, orgId, phoneNumber]);

    useEffect(() => {
        // Reset while the new chat's rows load so we never briefly show the
        // previous chat's labels against this one.
        setAssignedIds(new Set());
        fetchLabels();
        fetchAssignments();

        const channel = supabase
            .channel(`chatlabels-${phoneNumber}`)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'chat_labels', filter: `phone_number=eq.${phoneNumber}` },
                () => fetchAssignments(),
            )
            // Any label edit (rename / recolor / delete) — refresh the palette so
            // chips + the menu reflect it. A delete cascades chat_labels, which
            // the first listener catches.
            .on('postgres_changes', { event: '*', schema: 'public', table: 'labels' }, () => fetchLabels())
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [phoneNumber, supabase, fetchLabels, fetchAssignments]);

    const assigned = useMemo(() => labels.filter((l) => assignedIds.has(l.id)), [labels, assignedIds]);

    const toggle = async (labelId: string) => {
        if (!orgId) {
            toast.error('Gagal memperbarui label chat');
            return;
        }
        const isAssigned = assignedIds.has(labelId);
        // Optimistic — realtime + the catch-path refetch reconcile with the DB.
        setAssignedIds((prev) => {
            const next = new Set(prev);
            if (isAssigned) next.delete(labelId);
            else next.add(labelId);
            return next;
        });
        try {
            if (isAssigned) {
                const { error } = await supabase
                    .from('chat_labels')
                    .delete()
                    .eq('org_id', orgId)
                    .eq('phone_number', phoneNumber)
                    .eq('label_id', labelId);
                if (error) throw error;
            } else {
                // upsert + ignoreDuplicates so re-adding an already-assigned
                // label (stale optimistic set after a realtime gap / a second
                // open tab) is a harmless no-op instead of a PK-violation (23505)
                // that would toast a false failure.
                const { error } = await supabase
                    .from('chat_labels')
                    .upsert(
                        { org_id: orgId, phone_number: phoneNumber, label_id: labelId },
                        { onConflict: 'org_id,phone_number,label_id', ignoreDuplicates: true },
                    );
                if (error) throw error;
            }
        } catch {
            await fetchAssignments(); // revert to server truth
            toast.error('Gagal memperbarui label chat');
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-[var(--wa-panel)] px-3 py-1.5">
            {assigned.map((l) => (
                <LabelBadge key={l.id} label={l} size="xs" onRemove={() => toggle(l.id)} />
            ))}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label="Kelola label chat ini"
                        className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] font-medium text-[var(--wa-text-muted)] hover:bg-black/5 hover:text-[var(--wa-text)] dark:hover:bg-white/10"
                    >
                        <Tag className="h-3 w-3" />
                        {assigned.length === 0 ? 'Tambah label' : 'Label'}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel>Label chat ini</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {labels.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            Belum ada label. Buat dulu di Settings.
                        </div>
                    ) : (
                        labels.map((l) => {
                            const c = labelColor(l.color);
                            return (
                                <DropdownMenuCheckboxItem
                                    key={l.id}
                                    checked={assignedIds.has(l.id)}
                                    onCheckedChange={() => toggle(l.id)}
                                    onSelect={(e) => e.preventDefault()}
                                >
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', c.dot)} />
                                        <span className="truncate">{l.name}</span>
                                    </span>
                                </DropdownMenuCheckboxItem>
                            );
                        })
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <Link href="/dashboard/settings">
                            <Settings2 className="mr-2 h-4 w-4" />
                            Kelola label
                        </Link>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
