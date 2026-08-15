'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, MoreVertical, Check, CheckCheck, AlertCircle, FileText, Store, Clock, ChevronLeft, Trash2, Paperclip, X, Loader2, Download, ImageOff, Mic, Film, Zap, Smile, Search, ChevronUp, ChevronDown, Reply } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { SendTemplateDialog } from './SendTemplateDialog';
import { ContactTypeBadge } from '@/components/dashboard/ContactTypeBadge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { QuickReplyMenu } from './QuickReplyMenu';
import { EmojiPickerPanel } from './EmojiPicker';
import { HighlightedText } from './HighlightedText';
import { QuotedMessage } from './QuotedMessage';
import { ChatLabelsBar } from './ChatLabelsBar';
import {
    applyQuickReplyVars,
    parseSlashQuery,
    filterQuickReplies,
    type QuickReply,
} from '@/lib/quick-replies';

const STAGE_LABELS: Record<string, string> = {
    new: 'Baru',
    qualifying: 'Kualifikasi',
    quoted: 'Penawaran',
    scheduled: 'Meeting',
    booked: 'Booked',
    won: 'Closing',
    lost: 'Lost',
};

const WINDOW_MS = 24 * 60 * 60 * 1000; // Meta 24-hour customer service window

// >24h since the customer last messaged (or they never did) → free-form replies
// are blocked by Meta (131047); the admin must use a template.
function isWindowExpired(lastInboundAt: string | null): boolean {
    if (!lastInboundAt) return true;
    return Date.now() - new Date(lastInboundAt).getTime() > WINDOW_MS;
}

function formatLastActive(d: string | null): string {
    if (!d) return '';
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return '';
    return (
        'Aktif terakhir ' +
        date.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    );
}

type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed' | null;

// WhatsApp-style status indicator next to an outbound message bubble.
// Maps to Meta status callbacks: sent → 1 grey check, delivered → 2 grey
// checks, read → 2 blue checks, failed → red exclamation icon. Null/legacy
// rows show nothing so we don't lie about historical messages.
function MessageStatusIcon({ status }: { status: MessageStatus }) {
    if (status === 'failed') {
        return <AlertCircle className="h-3.5 w-3.5 text-red-600" aria-label="Failed" />;
    }
    if (status === 'read') {
        return <CheckCheck className="h-3.5 w-3.5 text-blue-500" aria-label="Read" />;
    }
    if (status === 'delivered') {
        return <CheckCheck className="h-3.5 w-3.5 text-zinc-500" aria-label="Delivered" />;
    }
    if (status === 'sent') {
        return <Check className="h-3.5 w-3.5 text-zinc-500" aria-label="Sent" />;
    }
    return null;
}

interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    created_at: string;
    status?: MessageStatus;
    error_code?: number | null;
    error_title?: string | null;
    error_detail?: string | null;
    media_type?: 'image' | 'document' | 'audio' | 'video' | null;
    media_url?: string | null;
    media_mime?: string | null;
    media_filename?: string | null;
    wa_message_id?: string | null;
    reply_to_wamid?: string | null;
}

interface ChatWindowProps {
    phoneNumber: string;
    // Mobile master-detail: returns from the conversation to the chat list.
    onBack?: () => void;
}

// Placeholder bubbles shown while a chat's history loads — alternating sides
// like a real conversation, in muted tones over the WhatsApp paper background.
function MessagesSkeleton() {
    const rows = [
        { out: false, w: 'w-48' },
        { out: true, w: 'w-56' },
        { out: false, w: 'w-40' },
        { out: true, w: 'w-44' },
        { out: false, w: 'w-52' },
    ];
    return (
        <div className="flex flex-col space-y-3">
            {rows.map((r, i) => (
                <Skeleton
                    key={i}
                    className={cn('h-10 rounded-lg bg-black/5 dark:bg-white/10', r.w, r.out ? 'self-end' : 'self-start')}
                />
            ))}
        </div>
    );
}

export function ChatWindow({ phoneNumber, onBack }: ChatWindowProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [loadingMsgs, setLoadingMsgs] = useState(true);
    const [newMessage, setNewMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [contactName, setContactName] = useState<string | null>(null);
    const [contactType, setContactType] = useState<string | null>(null);
    const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);
    const [lastInboundAt, setLastInboundAt] = useState<string | null>(null);
    const [crm, setCrm] = useState<{
        lead_stage: string | null;
        event_interest: string | null;
        participant_count: number | null;
        location_pref: string | null;
        vendor_category: string | null;
        vendor_offering: string | null;
        ai_enabled: boolean;
    }>({
        lead_stage: null,
        event_interest: null,
        participant_count: null,
        location_pref: null,
        vendor_category: null,
        vendor_offering: null,
        ai_enabled: true,
    });
    const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [pendingFile, setPendingFile] = useState<File | null>(null);
    const [uploadingMedia, setUploadingMedia] = useState(false);
    // Reply / quote: the message currently being replied to (null = normal send).
    const [replyingTo, setReplyingTo] = useState<Message | null>(null);
    const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null);
    const [contactCompany, setContactCompany] = useState<string | null>(null);
    // Quick replies (balasan cepat): the full list + the two ways to invoke them
    // — the ⚡ picker (searchable) and the "/" autocomplete (keyboard-driven).
    const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
    const [qrPickerOpen, setQrPickerOpen] = useState(false);
    const [qrPickerSearch, setQrPickerSearch] = useState('');
    const [qrHighlight, setQrHighlight] = useState(0);
    const [slashDismissed, setSlashDismissed] = useState(false);
    const [emojiOpen, setEmojiOpen] = useState(false);
    // In-conversation search.
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [matchIndex, setMatchIndex] = useState(0);
    // The normalized query that `matchIndex` was last aligned to (see the
    // render-time reset below).
    const [indexedQuery, setIndexedQuery] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const composerRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    // True while the user is pinned to the bottom. Background refreshes (the 10s
    // poll, realtime inserts) only auto-scroll when this holds — so scrolling up
    // to read history is never yanked back down.
    const atBottomRef = useRef(true);
    const supabase = createClient();

    const handleScroll = useCallback(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }, []);

    const fetchMessages = useCallback(async () => {
        // Fetch contact info
        const { data: contactData } = await supabase
            .from('whatsapp_chats')
            .select('contact_name, contact_type, company, last_message_at, last_inbound_at, lead_stage, event_interest, participant_count, location_pref, vendor_category, vendor_offering, ai_enabled')
            .eq('phone_number', phoneNumber)
            .single();

        if (contactData) {
            setContactName(contactData.contact_name);
            setContactType(contactData.contact_type);
            setContactCompany(contactData.company);
            setLastMessageAt(contactData.last_message_at);
            setLastInboundAt(contactData.last_inbound_at);
            setCrm({
                lead_stage: contactData.lead_stage,
                event_interest: contactData.event_interest,
                participant_count: contactData.participant_count,
                location_pref: contactData.location_pref,
                vendor_category: contactData.vendor_category,
                vendor_offering: contactData.vendor_offering,
                ai_enabled: contactData.ai_enabled ?? true,
            });
        }

        const { data, error } = await supabase
            .from('whatsapp_messages')
            .select('*')
            .eq('phone_number', phoneNumber)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('Error fetching messages:', error);
            toast.error('Failed to load messages');
        } else {
            setMessages(data || []);
        }
        setLoadingMsgs(false);
    }, [phoneNumber, supabase]);

    // Mark this conversation read → clears its unread badge in the chat list.
    // Opening the chat (or a new inbound arriving while it's open) is the "read"
    // signal; the webhook increments unread_count on every inbound. The
    // `.gt(0)` guard skips a needless write (and list refetch) when already 0.
    // Best-effort: a failure just leaves the badge until the next open.
    const markChatRead = useCallback(async () => {
        await supabase
            .from('whatsapp_chats')
            .update({ unread_count: 0 })
            .eq('phone_number', phoneNumber)
            .gt('unread_count', 0);
    }, [phoneNumber, supabase]);

    // Quick replies are org-global (not per-chat). Load on mount, and refresh
    // whenever the operator invokes them (see the rising-edge effect below) so
    // replies authored in Settings appear without a full page reload.
    const fetchQuickReplies = useCallback(async () => {
        const { data } = await supabase
            .from('quick_replies')
            .select('id, shortcut, content')
            .order('shortcut', { ascending: true });
        if (data) setQuickReplies(data as QuickReply[]);
    }, [supabase]);
    useEffect(() => {
        void fetchQuickReplies();
    }, [fetchQuickReplies]);

    useEffect(() => {
        // New chat selected → show the message skeleton until its history loads,
        // and drop the previous chat's messages so they don't flash here. Start
        // pinned to the bottom so the initial load lands on the latest message.
        atBottomRef.current = true;
        setLoadingMsgs(true);
        setMessages([]);
        fetchMessages();
        // Opening the chat clears its unread badge.
        void markChatRead();
        // Switching chats: reset the composer + quick-reply UI so a typed draft,
        // an attached file, or an open "/" menu never bleeds into — and gets sent
        // to — the next customer.
        setNewMessage('');
        setPendingFile(null);
        setQrPickerOpen(false);
        setQrPickerSearch('');
        setSlashDismissed(false);
        setQrHighlight(0);
        setEmojiOpen(false);
        setSearchOpen(false);
        setSearchQuery('');
        setReplyingTo(null);

        // Subscribe to real-time changes. INSERT = new message; UPDATE =
        // delivery-status change (sent → delivered → read, or failed) pushed
        // by the webhook status-callback handler. Without the UPDATE branch a
        // failed bubble would only turn red on the next 10s poll.
        const channel = supabase
            .channel(`whatsapp_messages:${phoneNumber}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'whatsapp_messages',
                filter: `phone_number=eq.${phoneNumber}`
            }, (payload) => {
                const incoming = payload.new as Message;
                // Dedup: handleSend() also calls fetchMessages() right after a
                // successful send, so the row may already be present.
                setMessages(prev =>
                    prev.some(m => m.id === incoming.id) ? prev : [...prev, incoming]
                );
                // A customer message arriving while the chat is open is read
                // immediately — keep the badge cleared (the webhook just bumped it).
                if (incoming.role === 'user') void markChatRead();
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'whatsapp_messages',
                filter: `phone_number=eq.${phoneNumber}`
            }, (payload) => {
                const updated = payload.new as Message;
                setMessages(prev =>
                    prev.map(m => (m.id === updated.id ? updated : m))
                );
            })
            // Contact row changes (rename, or klien/vendor re-classification from
            // the Contacts page) — keep the header name + badge live.
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'whatsapp_chats',
                filter: `phone_number=eq.${phoneNumber}`
            }, (payload) => {
                const row = payload.new as {
                    contact_name: string | null;
                    contact_type: string | null;
                    company: string | null;
                    last_message_at: string | null;
                    last_inbound_at: string | null;
                    lead_stage: string | null;
                    event_interest: string | null;
                    participant_count: number | null;
                    location_pref: string | null;
                    vendor_category: string | null;
                    vendor_offering: string | null;
                    ai_enabled: boolean | null;
                };
                setContactName(row.contact_name);
                setContactType(row.contact_type);
                setContactCompany(row.company);
                setLastMessageAt(row.last_message_at);
                setLastInboundAt(row.last_inbound_at);
                setCrm({
                    lead_stage: row.lead_stage,
                    event_interest: row.event_interest,
                    participant_count: row.participant_count,
                    location_pref: row.location_pref,
                    vendor_category: row.vendor_category,
                    vendor_offering: row.vendor_offering,
                    ai_enabled: row.ai_enabled ?? true,
                });
            })
            .subscribe();

        // Polling fallback - refresh every 10 seconds
        const pollInterval = setInterval(() => {
            fetchMessages();
        }, 10000);

        return () => {
            supabase.removeChannel(channel);
            clearInterval(pollInterval);
        };
    }, [phoneNumber, fetchMessages, markChatRead, supabase]);

    useEffect(() => {
        // Follow new messages only when the user is already at the bottom; if
        // they've scrolled up to read history, leave their scroll position alone.
        if (atBottomRef.current && scrollRef.current) {
            scrollRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    const handleSend = async () => {
        if (!newMessage.trim()) return;

        // The admin just sent → jump to the bottom to show their new bubble, even
        // if they'd scrolled up.
        atBottomRef.current = true;
        setSending(true);
        try {
            const response = await fetch('/api/chat/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone_number: phoneNumber,
                    message: newMessage,
                    context_message_id: replyingTo?.wa_message_id ?? null,
                })
            });

            if (!response.ok) {
                // Server returns { error, code?, fbtrace_id? } for Meta API
                // failures (e.g. past 24h window → code 131047). Show the
                // actual reason so admin knows what to do (resend later,
                // wait for customer reply, etc.) rather than a generic
                // "Failed to send message".
                const payload = (await response
                    .json()
                    .catch(() => ({} as { error?: string }))) as {
                    error?: string;
                    code?: number;
                };
                const reason = payload.error
                    || `Failed to send (HTTP ${response.status})`;
                throw new Error(reason);
            }

            setNewMessage('');
            setReplyingTo(null);
            // Force-refresh the message list immediately so the admin sees
            // their sent bubble appear. We can't rely on realtime alone
            // (only just enabled it) and the 10s polling interval feels
            // unresponsive — admins thought the send had failed.
            await fetchMessages();

        } catch (error) {
            console.error('Error sending message:', error);
            const msg = error instanceof Error
                ? error.message
                : 'Failed to send message';
            // Long Meta error descriptions wrap nicely in sonner's default
            // toast; keep it open longer so the admin can read it.
            toast.error(msg, { duration: 10_000 });
        } finally {
            setSending(false);
        }
    };

    const handleDeleteContact = async () => {
        setDeleting(true);
        try {
            const res = await fetch(`/api/leads/${encodeURIComponent(phoneNumber)}`, {
                method: 'DELETE',
            });
            if (res.ok || res.status === 404) {
                setDeleteOpen(false);
                toast.success(res.ok ? 'Kontak dihapus permanen' : 'Kontak sudah tidak ada');
                // Close the open conversation; ChatList drops the row via realtime.
                onBack?.();
            } else {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error ?? `HTTP ${res.status}`);
            }
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Gagal menghapus kontak', {
                duration: 8000,
            });
        } finally {
            setDeleting(false);
        }
    };

    // Object URL for the pending image preview — memoized + revoked so we don't
    // leak a new blob URL on every render.
    const previewUrl = useMemo(
        () => (pendingFile && pendingFile.type.startsWith('image/') ? URL.createObjectURL(pendingFile) : null),
        [pendingFile],
    );
    useEffect(() => {
        return () => {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        };
    }, [previewUrl]);

    const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = ''; // let the same file be re-picked after cancel
        if (!f) return;
        const isImage = f.type.startsWith('image/');
        const max = isImage ? 5 * 1024 * 1024 : 100 * 1024 * 1024;
        if (f.size > max) {
            toast.error(`File terlalu besar (maks ${isImage ? '5' : '100'} MB).`);
            return;
        }
        setPendingFile(f);
        // Reply is text-only for now; attaching a file exits reply mode.
        setReplyingTo(null);
    };

    const handleSendMedia = async () => {
        if (!pendingFile) return;
        // The 24h window can lapse after a file was attached (windowExpired is
        // recomputed each render). Media is a free-form message, so a send now
        // would be rejected by Meta (131047) — block it here so the Enter key
        // agrees with the already-disabled Send button.
        if (isWindowExpired(lastInboundAt)) {
            toast.error('Window 24 jam sudah habis — gunakan template message untuk mengirim lampiran.');
            return;
        }
        setUploadingMedia(true);
        atBottomRef.current = true;
        try {
            const fd = new FormData();
            fd.append('phone_number', phoneNumber);
            fd.append('file', pendingFile);
            if (newMessage.trim()) fd.append('caption', newMessage.trim());
            const res = await fetch('/api/chat/send-media', { method: 'POST', body: fd });
            if (!res.ok) {
                const payload = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(payload.error || `Gagal kirim (HTTP ${res.status})`);
            }
            setPendingFile(null);
            setNewMessage('');
            // Defensive: never let a reply context linger into the next text send.
            setReplyingTo(null);
            await fetchMessages();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Gagal mengirim file', { duration: 10_000 });
        } finally {
            setUploadingMedia(false);
        }
    };

    const groupedMessages = messages.reduce((acc, msg) => {
        const date = new Date(msg.created_at).toDateString();
        if (!acc[date]) acc[date] = [];
        acc[date].push(msg);
        return acc;
    }, {} as Record<string, Message[]>);

    const toggleAi = async (next: boolean) => {
        setCrm((c) => ({ ...c, ai_enabled: next })); // optimistic
        const { error } = await supabase
            .from('whatsapp_chats')
            .update({ ai_enabled: next })
            .eq('phone_number', phoneNumber);
        if (error) {
            setCrm((c) => ({ ...c, ai_enabled: !next })); // revert
            toast.error('Gagal mengubah mode AI');
        } else {
            toast.success(next ? 'AI aktif — balasan otomatis menyala' : 'Mode manual — AI berhenti membalas otomatis');
        }
    };

    const windowExpired = isWindowExpired(lastInboundAt);

    // ---- Quick replies: derived menu state + insert/keyboard handlers ----
    const qrVars = { nama: contactName, perusahaan: contactCompany, event: crm.event_interest };
    const slashQuery = parseSlashQuery(newMessage);
    const slashItems =
        slashQuery !== null ? filterQuickReplies(quickReplies, slashQuery, { prefix: true }) : [];
    // The "/" menu shows only when neither the ⚡ picker nor the emoji panel is
    // open, the input is a bare slash token, there are matches, and Esc hasn't
    // dismissed it.
    const slashOpen =
        !qrPickerOpen && !emojiOpen && slashQuery !== null && slashItems.length > 0 && !slashDismissed;
    const pickerItems = filterQuickReplies(quickReplies, qrPickerSearch);

    // Refresh the list on the rising edge of "quick replies invoked" — the picker
    // opening OR a "/" command starting. Keyed on slashQuery !== null (NOT
    // slashOpen): a stale list would keep slashOpen false and never trigger a
    // refresh, so a newly authored "/promo" would stay invisible.
    const slashActive = slashQuery !== null;
    useEffect(() => {
        if (qrPickerOpen || slashActive) void fetchQuickReplies();
    }, [qrPickerOpen, slashActive, fetchQuickReplies]);

    // Close the emoji / quick-reply panels if the 24h window lapses — otherwise
    // they'd hover over a now-disabled composer.
    useEffect(() => {
        if (windowExpired) {
            setEmojiOpen(false);
            setQrPickerOpen(false);
        }
    }, [windowExpired]);

    // Escape closes the emoji panel from anywhere. The picker never holds focus
    // (Frimousse doesn't auto-focus and its emoji buttons preventDefault focus),
    // so a panel-scoped keydown handler wouldn't fire — use a document listener.
    useEffect(() => {
        if (!emojiOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setEmojiOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [emojiOpen]);

    // ---- In-conversation search: matches + navigation + scroll-to-hit ----
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const searchMatchIds = useMemo(() => {
        if (!normalizedQuery) return [] as string[];
        return messages
            .filter((m) => m.content && m.content.toLowerCase().includes(normalizedQuery))
            .map((m) => m.id);
    }, [messages, normalizedQuery]);
    const matchCount = searchMatchIds.length;
    const clampedMatchIndex = matchCount ? Math.max(0, Math.min(matchIndex, matchCount - 1)) : 0;
    const currentMatchId = matchCount ? searchMatchIds[clampedMatchIndex] : null;

    // Reset the selection to the most recent (bottom-most) hit whenever the
    // NORMALIZED query changes — done during render (React's "reset state when a
    // value changes" pattern) so it happens synchronously before the scroll
    // effect runs (no stale-index double-scroll), and a whitespace-only edit,
    // which leaves normalizedQuery unchanged, is a no-op.
    if (indexedQuery !== normalizedQuery) {
        setIndexedQuery(normalizedQuery);
        setMatchIndex(matchCount ? matchCount - 1 : 0);
    }

    const closeSearch = () => {
        setSearchOpen(false);
        setSearchQuery('');
    };
    // Both handlers floor at 0 and no-op when there are no matches, so the index
    // can never go negative (which would strand the counter at "0/N").
    const gotoPrevMatch = () =>
        setMatchIndex((i) => (matchCount ? Math.max(0, Math.min(i, matchCount - 1) - 1) : 0));
    const gotoNextMatch = () =>
        setMatchIndex((i) =>
            matchCount ? Math.min(matchCount - 1, Math.max(0, Math.min(i, matchCount - 1)) + 1) : 0,
        );

    // Focus the search field when the bar opens.
    useEffect(() => {
        if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
    }, [searchOpen]);

    // Scroll the current hit into view whenever the RESOLVED target message
    // changes. Keyed on the message id (not matchIndex/query) so it fires once
    // per real target change and stays put on the 10s poll — the id is stable
    // while the same hit remains selected.
    useEffect(() => {
        if (!searchOpen || !currentMatchId) return;
        atBottomRef.current = false;
        document.getElementById(`msg-${currentMatchId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [currentMatchId, searchOpen]);

    // ---- Reply / quote ----
    // Resolve a quoted message locally by matching reply_to_wamid to wa_message_id.
    const messageByWamid = useMemo(() => {
        const map = new Map<string, Message>();
        for (const m of messages) if (m.wa_message_id) map.set(m.wa_message_id, m);
        return map;
    }, [messages]);

    const messageSnippet = (m: Message): string => {
        if (m.content && m.content.trim()) return m.content;
        switch (m.media_type) {
            case 'image': return '📷 Foto';
            case 'video': return '🎬 Video';
            case 'audio': return '🎤 Pesan suara';
            case 'document': return `📎 ${m.media_filename || 'Dokumen'}`;
            default: return 'Pesan';
        }
    };
    const senderLabel = (m: Message): string =>
        m.role === 'assistant' ? 'Anda' : m.role === 'system' ? 'Sistem' : contactName || phoneNumber;

    const startReply = (m: Message) => {
        setReplyingTo(m);
        // Reply is text-only, so it's mutually exclusive with a pending attachment.
        setPendingFile(null);
        setEmojiOpen(false);
        setQrPickerOpen(false);
        requestAnimationFrame(() => composerRef.current?.focus());
    };

    const scrollToMessage = (id: string) => {
        atBottomRef.current = false;
        document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    const insertQuickReply = (qr: QuickReply) => {
        const text = applyQuickReplyVars(qr.content, qrVars);
        setNewMessage((prev) => {
            // Slash path: the whole input is the "/shortcut" token → replace it.
            if (parseSlashQuery(prev) !== null) return text;
            // Picker path with an existing draft → append so typed text isn't lost.
            if (prev.trim()) return prev.endsWith(' ') ? prev + text : `${prev} ${text}`;
            return text;
        });
        setQrPickerOpen(false);
        setQrPickerSearch('');
        setQrHighlight(0);
        // Return focus to the composer so the admin can edit/send right away.
        requestAnimationFrame(() => composerRef.current?.focus());
    };

    // Splice an emoji into the composer at the caret (not just append), then put
    // the cursor right after it. selectionStart/End and setSelectionRange share
    // UTF-16 offsets, so multi-code-unit emoji land correctly. The panel stays
    // open so several emoji can be added in a row.
    const insertAtCaret = (text: string) => {
        const el = composerRef.current;
        // Composer disabled (sending / window expired) — don't insert into a field
        // that can't be sent or is about to be cleared.
        if (el?.disabled) return;
        if (!el) {
            setNewMessage((prev) => prev + text);
            return;
        }
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        setNewMessage((prev) => prev.slice(0, start) + text + prev.slice(end));
        requestAnimationFrame(() => {
            el.focus();
            const pos = start + text.length;
            try {
                el.setSelectionRange(pos, pos);
            } catch {
                /* setSelectionRange can throw on some inputs — ignore */
            }
        });
    };

    const onComposerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!slashOpen) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setQrHighlight((h) => Math.min(h + 1, slashItems.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setQrHighlight((h) => Math.max(h - 1, 0));
        } else if (e.key === 'Enter') {
            // Select the highlighted reply instead of submitting the form.
            e.preventDefault();
            const pick = slashItems[Math.min(qrHighlight, slashItems.length - 1)];
            if (pick) insertQuickReply(pick);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setSlashDismissed(true);
        }
    };

    return (
        <div className="flex flex-col h-full bg-[var(--wa-paper)]">
            <div className="p-3 border-b flex justify-between items-center gap-2 bg-[var(--wa-panel)] shadow-sm flex-shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    {onBack && (
                        <button
                            type="button"
                            onClick={onBack}
                            aria-label="Kembali ke daftar chat"
                            className="md:hidden -ml-1 shrink-0 rounded-full p-1.5 text-[var(--wa-header-icon)] hover:bg-black/5 dark:hover:bg-white/10"
                        >
                            <ChevronLeft className="h-5 w-5" />
                        </button>
                    )}
                    <div className="h-10 w-10 rounded-full bg-[var(--wa-avatar)] flex items-center justify-center shrink-0">
                        {contactType === 'vendor' ? (
                            <Store className="w-5 h-5 text-orange-500" />
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-[var(--wa-icon)]">
                                <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clipRule="evenodd" />
                            </svg>
                        )}
                    </div>
                    <div className="min-w-0">
                        <h2 className="font-semibold text-sm text-[var(--wa-text)] flex items-center gap-2 min-w-0">
                            <span className="truncate">{contactName || phoneNumber}</span>
                            <ContactTypeBadge type={contactType} />
                        </h2>
                        <p className="text-xs text-[var(--wa-text-muted)] truncate">{formatLastActive(lastMessageAt) || phoneNumber}</p>
                    </div>
                </div>
                <div className="flex gap-4 text-[var(--wa-header-icon)] shrink-0">
                    <button
                        type="button"
                        aria-label="Cari dalam percakapan"
                        onClick={() => setSearchOpen(true)}
                        className="rounded-full p-1 hover:bg-black/5 dark:hover:bg-white/10"
                    >
                        <Search className="h-5 w-5 cursor-pointer hover:text-[var(--wa-text)]" />
                    </button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="Menu kontak"
                                className="rounded-full p-1 hover:bg-black/5 dark:hover:bg-white/10"
                            >
                                <MoreVertical className="h-5 w-5 cursor-pointer hover:text-[var(--wa-text)]" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onClick={() => setDeleteOpen(true)}
                                className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Hapus kontak
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <ChatLabelsBar phoneNumber={phoneNumber} />

            {searchOpen && (
                <div className="flex items-center gap-2 border-b bg-[var(--wa-panel)] px-3 py-2">
                    <Search className="h-4 w-4 shrink-0 text-[var(--wa-text-muted)]" />
                    <input
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') closeSearch();
                            else if (e.key === 'Enter') {
                                e.preventDefault();
                                if (matchCount === 0) return;
                                if (e.shiftKey) gotoNextMatch();
                                else gotoPrevMatch();
                            }
                        }}
                        placeholder="Cari dalam percakapan…"
                        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--wa-text)] outline-none placeholder:text-[var(--wa-text-muted)]"
                    />
                    <span className="shrink-0 text-xs tabular-nums text-[var(--wa-text-muted)]">
                        {matchCount ? `${clampedMatchIndex + 1}/${matchCount}` : searchQuery.trim() ? '0/0' : ''}
                    </span>
                    <button
                        type="button"
                        onClick={gotoPrevMatch}
                        disabled={matchCount === 0}
                        aria-label="Hasil sebelumnya"
                        className="rounded-full p-1 text-[var(--wa-header-icon)] hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                    >
                        <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={gotoNextMatch}
                        disabled={matchCount === 0}
                        aria-label="Hasil berikutnya"
                        className="rounded-full p-1 text-[var(--wa-header-icon)] hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                    >
                        <ChevronDown className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={closeSearch}
                        aria-label="Tutup pencarian"
                        className="rounded-full p-1 text-[var(--wa-header-icon)] hover:bg-black/5 dark:hover:bg-white/10"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}

            {/* CRM context + AI/Manual takeover toggle */}
            <div className="px-3 py-1.5 bg-[var(--wa-crm)] border-b flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-[var(--wa-text-muted)]">
                    {contactType === 'vendor' ? (
                        crm.vendor_category || crm.vendor_offering ? (
                            <>
                                {crm.vendor_category && (
                                    <span className="capitalize">Kategori: <span className="text-[var(--wa-text)]">{crm.vendor_category}</span></span>
                                )}
                                {crm.vendor_offering && (
                                    <span className="truncate">Tawaran: <span className="text-[var(--wa-text)]">{crm.vendor_offering}</span></span>
                                )}
                            </>
                        ) : (
                            <span className="italic">Belum ada detail vendor</span>
                        )
                    ) : crm.lead_stage || crm.event_interest || crm.participant_count || crm.location_pref ? (
                        <>
                            {crm.lead_stage && (
                                <span>Tahap: <span className="font-medium text-[var(--wa-text)]">{STAGE_LABELS[crm.lead_stage] ?? crm.lead_stage}</span></span>
                            )}
                            {crm.event_interest && <span>Acara: <span className="text-[var(--wa-text)]">{crm.event_interest}</span></span>}
                            {crm.participant_count ? <span><span className="text-[var(--wa-text)]">{crm.participant_count}</span> pax</span> : null}
                            {crm.location_pref && <span className="truncate">{crm.location_pref}</span>}
                        </>
                    ) : (
                        <span className="italic">Belum ada detail lead</span>
                    )}
                </div>
                <div
                    className="flex shrink-0 items-center gap-1.5 select-none"
                    title="Saat Manual, AI berhenti membalas otomatis dan Anda menangani chat ini sendiri."
                >
                    <span className={cn('text-[12px] font-medium', crm.ai_enabled ? 'text-emerald-600' : 'text-zinc-500')}>
                        {crm.ai_enabled ? 'AI aktif' : 'Manual'}
                    </span>
                    <Switch checked={crm.ai_enabled} onCheckedChange={toggleAi} aria-label="Toggle balasan otomatis AI" />
                </div>
            </div>

            <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4">
                <div className="flex flex-col space-y-4 pb-4">
                    {loadingMsgs && messages.length === 0 && <MessagesSkeleton />}
                    {Object.entries(groupedMessages).map(([date, msgs]) => (
                        <div key={date} className="flex flex-col space-y-4">
                            <div className="flex justify-center sticky top-2">
                                <span className="bg-[var(--wa-panel)] shadow-sm rounded-lg px-3 py-1 text-xs text-[var(--wa-text-muted)] font-medium">
                                    {new Date(date).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                </span>
                            </div>
                            {msgs.map((msg) => {
                                if (msg.role === 'system') {
                                    return (
                                        <div id={`msg-${msg.id}`} key={msg.id} className="flex justify-center my-2">
                                            <span className="bg-[#ffeecd] text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-200 text-xs px-3 py-1 rounded-lg text-center shadow-sm max-w-[80%]">
                                                {searchOpen && searchQuery.trim() ? (
                                                    <HighlightedText text={msg.content} query={searchQuery} active={msg.id === currentMatchId} />
                                                ) : (
                                                    msg.content
                                                )}
                                            </span>
                                        </div>
                                    );
                                }

                                const isOutbound = msg.role === 'assistant';
                                const failed = isOutbound && msg.status === 'failed';
                                const replyParent = msg.reply_to_wamid
                                    ? messageByWamid.get(msg.reply_to_wamid)
                                    : undefined;
                                return (
                                    <div
                                        id={`msg-${msg.id}`}
                                        key={msg.id}
                                        className={cn(
                                            "group max-w-[80%] rounded-lg p-2 px-3 text-sm shadow-sm relative",
                                            msg.role === 'user'
                                                ? "bg-[var(--wa-bubble-in)] self-start text-[var(--wa-text)] rounded-tl-none"
                                                : failed
                                                    ? "bg-red-50 border border-red-300 self-end text-black rounded-tr-none dark:bg-red-950/40 dark:border-red-900 dark:text-red-50"
                                                    : "bg-[var(--wa-bubble-out)] self-end text-[var(--wa-text)] rounded-tr-none"
                                        )}
                                    >
                                        {/* Reply affordance (hover). Only for messages that carry a wamid —
                                            the WhatsApp reply-context needs one — and while the 24h window is open. */}
                                        {msg.wa_message_id && !windowExpired && (
                                            <button
                                                type="button"
                                                onClick={() => startReply(msg)}
                                                aria-label="Balas pesan ini"
                                                title="Balas"
                                                className="absolute -top-2.5 right-1 z-10 rounded-full border bg-[var(--wa-panel)] p-1 text-[var(--wa-header-icon)] opacity-0 shadow-sm transition-opacity hover:text-[var(--wa-text)] group-hover:opacity-100"
                                            >
                                                <Reply className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                        {msg.reply_to_wamid &&
                                            (replyParent ? (
                                                <QuotedMessage
                                                    className="mb-1"
                                                    sender={senderLabel(replyParent)}
                                                    snippet={messageSnippet(replyParent)}
                                                    onClick={() => scrollToMessage(replyParent.id)}
                                                />
                                            ) : (
                                                <QuotedMessage
                                                    className="mb-1"
                                                    sender="Pesan dikutip"
                                                    snippet="Pesan tidak tersedia"
                                                />
                                            ))}
                                        {msg.media_type === 'image' &&
                                            (msg.media_url ? (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setLightbox({
                                                            url: msg.media_url!,
                                                            name: msg.media_filename || 'Gambar',
                                                        })
                                                    }
                                                    className="mb-1 block cursor-zoom-in"
                                                >
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={msg.media_url}
                                                        alt={msg.media_filename || 'Gambar'}
                                                        loading="lazy"
                                                        className="max-h-64 w-auto max-w-full rounded-md object-cover"
                                                    />
                                                </button>
                                            ) : (
                                                // Storage copy failed but the photo WAS delivered — show a
                                                // placeholder so the bubble isn't blank (mirrors the doc card).
                                                <div className="mb-1 flex items-center gap-2 rounded-md bg-black/5 p-2 opacity-70 dark:bg-white/10">
                                                    <ImageOff className="h-8 w-8 shrink-0 text-[var(--wa-header-icon)]" />
                                                    <span className="min-w-0 flex-1 truncate text-sm">
                                                        {msg.media_filename || 'Foto'} — pratinjau tidak tersedia
                                                    </span>
                                                </div>
                                            ))}
                                        {msg.media_type === 'audio' &&
                                            (msg.media_url ? (
                                                <audio
                                                    controls
                                                    preload="none"
                                                    src={msg.media_url}
                                                    className="mb-1 h-10 w-56 max-w-full"
                                                />
                                            ) : (
                                                <div className="mb-1 flex items-center gap-2 rounded-md bg-black/5 p-2 opacity-70 dark:bg-white/10">
                                                    <Mic className="h-8 w-8 shrink-0 text-[var(--wa-header-icon)]" />
                                                    <span className="min-w-0 flex-1 truncate text-sm">
                                                        Pesan suara — tidak tersedia
                                                    </span>
                                                </div>
                                            ))}
                                        {msg.media_type === 'video' &&
                                            (msg.media_url ? (
                                                <video
                                                    controls
                                                    preload="metadata"
                                                    src={msg.media_url}
                                                    className="mb-1 max-h-64 w-auto max-w-full rounded-md"
                                                />
                                            ) : (
                                                <div className="mb-1 flex items-center gap-2 rounded-md bg-black/5 p-2 opacity-70 dark:bg-white/10">
                                                    <Film className="h-8 w-8 shrink-0 text-[var(--wa-header-icon)]" />
                                                    <span className="min-w-0 flex-1 truncate text-sm">
                                                        Video — tidak tersedia
                                                    </span>
                                                </div>
                                            ))}
                                        {msg.media_type === 'document' && (
                                            <a
                                                href={msg.media_url ?? undefined}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className={cn(
                                                    'mb-1 flex items-center gap-2 rounded-md bg-black/5 p-2 dark:bg-white/10',
                                                    !msg.media_url && 'pointer-events-none opacity-70'
                                                )}
                                            >
                                                <FileText className="h-8 w-8 shrink-0 text-[var(--wa-header-icon)]" />
                                                <span className="min-w-0 flex-1 truncate text-sm">
                                                    {msg.media_filename || 'Dokumen'}
                                                </span>
                                                {msg.media_url && <Download className="h-4 w-4 shrink-0" />}
                                            </a>
                                        )}
                                        {msg.content && (
                                            <p className="leading-relaxed whitespace-pre-wrap">
                                                {searchOpen && searchQuery.trim() ? (
                                                    <HighlightedText text={msg.content} query={searchQuery} active={msg.id === currentMatchId} />
                                                ) : (
                                                    msg.content
                                                )}
                                            </p>
                                        )}
                                        <div className="flex items-center justify-end gap-1 mt-1 text-[10px] text-[var(--wa-text-muted)]">
                                            <span>
                                                {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                            {isOutbound && <MessageStatusIcon status={msg.status ?? null} />}
                                        </div>
                                        {failed && (
                                            <div className="mt-1 text-[11px] text-red-700 border-t border-red-200 pt-1 dark:text-red-300 dark:border-red-900/50">
                                                <div className="flex items-start gap-1">
                                                    <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                                                    <div>
                                                        <div className="font-medium">
                                                            {msg.error_title ?? 'Gagal terkirim'}
                                                            {msg.error_code ? ` (Kode ${msg.error_code})` : ''}
                                                        </div>
                                                        {msg.error_detail && (
                                                            <div className="opacity-80">{msg.error_detail}</div>
                                                        )}
                                                        {msg.error_code === 131047 && (
                                                            <div className="mt-1 italic opacity-90">
                                                                Tip: Customer harus kirim pesan dulu, ATAU pakai template message yang sudah di-approve di Meta Business Manager.
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                    <div ref={scrollRef} />
                </div>
            </div>

            <div className="relative p-3 bg-[var(--wa-panel)] flex flex-col gap-2 flex-shrink-0">
                {(qrPickerOpen || slashOpen) && (
                    <>
                        {qrPickerOpen && (
                            <div
                                className="fixed inset-0 z-40"
                                onClick={() => setQrPickerOpen(false)}
                                aria-hidden
                            />
                        )}
                        <div className="absolute bottom-full left-3 right-3 z-50 mb-2 overflow-hidden rounded-lg border bg-[var(--wa-panel)] shadow-lg">
                            {qrPickerOpen && (
                                <div className="border-b p-2">
                                    <Input
                                        autoFocus
                                        value={qrPickerSearch}
                                        onChange={(e) => { setQrPickerSearch(e.target.value); setQrHighlight(0); }}
                                        placeholder="Cari balasan cepat…"
                                        className="h-9 border-none bg-[var(--wa-search)] text-[var(--wa-text)] focus-visible:ring-0"
                                    />
                                </div>
                            )}
                            {slashOpen && (
                                <div className="border-b px-3 py-1.5 text-[11px] text-[var(--wa-text-muted)]">
                                    Balasan cepat — ↑↓ pilih · Enter sisipkan · Esc tutup
                                </div>
                            )}
                            {quickReplies.length === 0 ? (
                                <div className="px-3 py-3 text-sm text-[var(--wa-text-muted)]">
                                    Belum ada balasan cepat. Tambah di <strong>Settings → Balasan Cepat</strong>.
                                </div>
                            ) : (
                                <QuickReplyMenu
                                    items={qrPickerOpen ? pickerItems : slashItems}
                                    highlight={qrHighlight}
                                    onSelect={insertQuickReply}
                                    onHover={(i) => setQrHighlight(i)}
                                />
                            )}
                        </div>
                    </>
                )}
                {emojiOpen && (
                    <>
                        <div
                            className="fixed inset-0 z-40"
                            onClick={() => setEmojiOpen(false)}
                            aria-hidden
                        />
                        <div className="absolute bottom-full left-3 z-50 mb-2 w-80 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-lg border shadow-lg">
                            <EmojiPickerPanel onPick={insertAtCaret} />
                        </div>
                    </>
                )}
                {windowExpired && (
                    <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-100 px-2.5 py-1.5 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
                        <Clock className="h-3.5 w-3.5 shrink-0" />
                        <span>
                            Lebih dari 24 jam sejak pesan terakhir customer — balasan biasa akan ditolak Meta. Gunakan <strong>template message</strong>.
                        </span>
                    </div>
                )}
                {replyingTo && (
                    <div className="flex items-start gap-2 rounded-md border bg-[var(--wa-search)] p-2">
                        <div className="min-w-0 flex-1">
                            <QuotedMessage
                                sender={`Membalas ${senderLabel(replyingTo)}`}
                                snippet={messageSnippet(replyingTo)}
                            />
                        </div>
                        <button
                            type="button"
                            onClick={() => setReplyingTo(null)}
                            aria-label="Batalkan balasan"
                            className="mt-0.5 rounded-full p-1 text-[var(--wa-header-icon)] hover:bg-black/10 dark:hover:bg-white/10"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                )}
                {pendingFile && (
                    <div className="flex items-center gap-2 rounded-md border bg-[var(--wa-search)] p-2">
                        {previewUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={previewUrl} alt="pratinjau" className="h-12 w-12 rounded object-cover" />
                        ) : (
                            <FileText className="h-9 w-9 text-[var(--wa-header-icon)]" />
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-[var(--wa-text)]">{pendingFile.name}</p>
                            <p className="text-xs text-[var(--wa-text-muted)]">
                                {(pendingFile.size / 1024).toFixed(0)} KB · siap dikirim
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setPendingFile(null)}
                            disabled={uploadingMedia}
                            aria-label="Batalkan lampiran"
                            className="rounded-full p-1 text-[var(--wa-header-icon)] hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                )}
                {/* z-50 lifts the toolbar above the panel backdrop (z-40) so a single
                    click on any button acts immediately (e.g. switching pickers) instead
                    of only closing the open panel. */}
                <div className="relative z-50 flex items-center gap-2">
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => setTemplateDialogOpen(true)}
                        title="Kirim template message (re-engage di luar 24-jam window)"
                        aria-label="Send template message"
                        className={cn(
                            "h-12 w-12 rounded-lg shrink-0",
                            windowExpired
                                ? "bg-amber-100 text-amber-800 hover:bg-amber-200 ring-1 ring-amber-300 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30 dark:hover:bg-amber-500/25"
                                : "text-[var(--wa-header-icon)] hover:text-[var(--wa-text)] hover:bg-[var(--wa-hover)]"
                        )}
                    >
                        <FileText className="h-5 w-5" />
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                        className="hidden"
                        onChange={onPickFile}
                    />
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={windowExpired || uploadingMedia}
                        title="Lampirkan foto atau file"
                        aria-label="Lampirkan file"
                        className="h-12 w-12 rounded-lg shrink-0 text-[var(--wa-header-icon)] hover:text-[var(--wa-text)] hover:bg-[var(--wa-hover)]"
                    >
                        <Paperclip className="h-5 w-5" />
                    </Button>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => { setQrPickerOpen((o) => !o); setQrPickerSearch(''); setQrHighlight(0); setEmojiOpen(false); }}
                        disabled={windowExpired || uploadingMedia}
                        title="Balasan cepat (atau ketik / di awal pesan)"
                        aria-label="Balasan cepat"
                        className={cn(
                            "h-12 w-12 rounded-lg shrink-0 hover:text-[var(--wa-text)] hover:bg-[var(--wa-hover)]",
                            qrPickerOpen ? "text-[var(--wa-text)] bg-[var(--wa-hover)]" : "text-[var(--wa-header-icon)]"
                        )}
                    >
                        <Zap className="h-5 w-5" />
                    </Button>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => { setEmojiOpen((o) => !o); setQrPickerOpen(false); }}
                        disabled={windowExpired || uploadingMedia || sending}
                        title="Emoji"
                        aria-label="Emoji"
                        aria-haspopup="dialog"
                        aria-expanded={emojiOpen}
                        className={cn(
                            "h-12 w-12 rounded-lg shrink-0 hover:text-[var(--wa-text)] hover:bg-[var(--wa-hover)]",
                            emojiOpen ? "text-[var(--wa-text)] bg-[var(--wa-hover)]" : "text-[var(--wa-header-icon)]"
                        )}
                    >
                        <Smile className="h-5 w-5" />
                    </Button>
                    <form
                        onSubmit={(e) => { e.preventDefault(); if (pendingFile) { handleSendMedia(); } else { handleSend(); } }}
                        className="flex gap-2 w-full"
                    >
                        <Input
                            ref={composerRef}
                            value={newMessage}
                            onChange={(e) => { setNewMessage(e.target.value); setSlashDismissed(false); setQrHighlight(0); }}
                            onKeyDown={onComposerKeyDown}
                            placeholder={
                                pendingFile
                                    ? 'Tambah caption (opsional)…'
                                    : windowExpired
                                        ? 'Window 24 jam habis — kirim template message'
                                        : 'Type a message'
                            }
                            disabled={sending || uploadingMedia || (windowExpired && !pendingFile)}
                            className="bg-[var(--wa-search)] border-none focus-visible:ring-0 rounded-lg py-6 text-[var(--wa-text)] disabled:opacity-60"
                        />
                        <Button
                            type="submit"
                            size="icon"
                            disabled={sending || uploadingMedia || windowExpired || (!pendingFile && !newMessage.trim())}
                            className={cn(
                                "h-12 w-12 rounded-lg shrink-0 transition-all",
                                (pendingFile || newMessage.trim()) && !windowExpired ? "bg-[#00a884] hover:bg-[#008f6f]" : "bg-transparent text-muted-foreground hover:bg-transparent"
                            )}
                        >
                            {uploadingMedia ? (
                                <Loader2 className="h-5 w-5 animate-spin text-white" />
                            ) : (
                                <Send className={cn("h-5 w-5", (pendingFile || newMessage.trim()) && !windowExpired ? "text-white" : "text-muted-foreground")} />
                            )}
                        </Button>
                    </form>
                </div>
            </div>

            <Dialog open={!!lightbox} onOpenChange={(o) => { if (!o) setLightbox(null); }}>
                <DialogContent className="max-w-2xl">
                    <DialogTitle className="truncate pr-8 text-sm font-medium">
                        {lightbox?.name || 'Pratinjau'}
                    </DialogTitle>
                    {lightbox && (
                        <div className="flex flex-col items-center gap-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={lightbox.url}
                                alt={lightbox.name}
                                className="mx-auto max-h-[75vh] w-auto max-w-full rounded-md object-contain"
                            />
                            <a
                                href={lightbox.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-muted-foreground underline hover:text-foreground"
                            >
                                Buka ukuran asli di tab baru
                            </a>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <Dialog open={deleteOpen} onOpenChange={(o) => { if (!deleting) setDeleteOpen(o); }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Hapus kontak ini?</DialogTitle>
                        <DialogDescription>
                            Seluruh <strong>chat, memori AI, dan data kontak</strong> untuk{' '}
                            <strong>{contactName || phoneNumber}</strong> akan dihapus permanen
                            dan tidak bisa dikembalikan. Bila kontak punya booking, penghapusan
                            ditolak demi menjaga data pesanan.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                            Batal
                        </Button>
                        <Button variant="destructive" onClick={handleDeleteContact} disabled={deleting}>
                            {deleting ? 'Menghapus…' : 'Hapus permanen'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <SendTemplateDialog
                open={templateDialogOpen}
                onOpenChange={setTemplateDialogOpen}
                phoneNumber={phoneNumber}
                onSent={fetchMessages}
            />
        </div>
    );
}
