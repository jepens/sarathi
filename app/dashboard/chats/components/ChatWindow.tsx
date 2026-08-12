'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, MoreVertical, Check, CheckCheck, AlertCircle, FileText, Store, Clock, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { SendTemplateDialog } from './SendTemplateDialog';
import { ContactTypeBadge } from '@/components/dashboard/ContactTypeBadge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';

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
            .select('contact_name, contact_type, last_message_at, last_inbound_at, lead_stage, event_interest, participant_count, location_pref, vendor_category, vendor_offering, ai_enabled')
            .eq('phone_number', phoneNumber)
            .single();

        if (contactData) {
            setContactName(contactData.contact_name);
            setContactType(contactData.contact_type);
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

    useEffect(() => {
        // New chat selected → show the message skeleton until its history loads,
        // and drop the previous chat's messages so they don't flash here. Start
        // pinned to the bottom so the initial load lands on the latest message.
        atBottomRef.current = true;
        setLoadingMsgs(true);
        setMessages([]);
        fetchMessages();

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
    }, [phoneNumber, fetchMessages, supabase]);

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
                    message: newMessage
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
                    <MoreVertical className="h-5 w-5 cursor-pointer hover:text-[var(--wa-text)]" />
                </div>
            </div>

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
                                        <div key={msg.id} className="flex justify-center my-2">
                                            <span className="bg-[#ffeecd] text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-200 text-xs px-3 py-1 rounded-lg text-center shadow-sm max-w-[80%]">
                                                {msg.content}
                                            </span>
                                        </div>
                                    );
                                }

                                const isOutbound = msg.role === 'assistant';
                                const failed = isOutbound && msg.status === 'failed';
                                return (
                                    <div
                                        key={msg.id}
                                        className={cn(
                                            "max-w-[80%] rounded-lg p-2 px-3 text-sm shadow-sm relative",
                                            msg.role === 'user'
                                                ? "bg-[var(--wa-bubble-in)] self-start text-[var(--wa-text)] rounded-tl-none"
                                                : failed
                                                    ? "bg-red-50 border border-red-300 self-end text-black rounded-tr-none dark:bg-red-950/40 dark:border-red-900 dark:text-red-50"
                                                    : "bg-[var(--wa-bubble-out)] self-end text-[var(--wa-text)] rounded-tr-none"
                                        )}
                                    >
                                        <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>
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

            <div className="p-3 bg-[var(--wa-panel)] flex flex-col gap-2 flex-shrink-0">
                {windowExpired && (
                    <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-100 px-2.5 py-1.5 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
                        <Clock className="h-3.5 w-3.5 shrink-0" />
                        <span>
                            Lebih dari 24 jam sejak pesan terakhir customer — balasan biasa akan ditolak Meta. Gunakan <strong>template message</strong>.
                        </span>
                    </div>
                )}
                <div className="flex items-center gap-2">
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
                    <form
                        onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                        className="flex gap-2 w-full"
                    >
                        <Input
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            placeholder={windowExpired ? 'Window 24 jam habis — kirim template message' : 'Type a message'}
                            disabled={sending || windowExpired}
                            className="bg-[var(--wa-search)] border-none focus-visible:ring-0 rounded-lg py-6 text-[var(--wa-text)] disabled:opacity-60"
                        />
                        <Button
                            type="submit"
                            size="icon"
                            disabled={sending || !newMessage.trim() || windowExpired}
                            className={cn(
                                "h-12 w-12 rounded-lg shrink-0 transition-all",
                                newMessage.trim() && !windowExpired ? "bg-[#00a884] hover:bg-[#008f6f]" : "bg-transparent text-muted-foreground hover:bg-transparent"
                            )}
                        >
                            <Send className={cn("h-5 w-5", newMessage.trim() && !windowExpired ? "text-white" : "text-muted-foreground")} />
                        </Button>
                    </form>
                </div>
            </div>

            <SendTemplateDialog
                open={templateDialogOpen}
                onOpenChange={setTemplateDialogOpen}
                phoneNumber={phoneNumber}
                onSent={fetchMessages}
            />
        </div>
    );
}
