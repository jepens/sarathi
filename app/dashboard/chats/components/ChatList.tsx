'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Input } from '@/components/ui/input';
import { Search, Clock, Store } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ContactTypeBadge } from '@/components/dashboard/ContactTypeBadge';

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
    const supabase = createClient();

    const fetchChats = useCallback(async () => {
        const { data, error } = await supabase
            .from('whatsapp_chats')
            .select('*')
            .order('last_message_at', { ascending: false });

        if (error) {
            console.error('Error fetching chats:', error);
        } else {
            setChats(data || []);
        }
        setLoading(false);
    }, [supabase]);

    useEffect(() => {
        const loadChats = async () => {
            await fetchChats();
        };
        loadChats();

        // Subscribe to real-time changes
        const channel = supabase
            .channel('whatsapp_chats_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_chats' }, () => {
                fetchChats();
            })
            .subscribe();

        // Polling fallback - refresh every 30 seconds
        const pollInterval = setInterval(() => {
            fetchChats();
        }, 30000);

        return () => {
            supabase.removeChannel(channel);
            clearInterval(pollInterval);
        };
    }, [fetchChats, supabase]);

    const filteredChats = chats.filter(chat =>
        chat.phone_number.includes(search) ||
        (chat.contact_name && chat.contact_name.toLowerCase().includes(search.toLowerCase())) ||
        chat.last_message?.toLowerCase().includes(search.toLowerCase())
    );

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
        <div className="flex flex-col h-full bg-white">
            <div className="p-3 border-b bg-[#f0f2f5] flex-shrink-0">
                <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search or start new chat"
                        className="pl-10 bg-white border-none focus-visible:ring-1 rounded-lg text-black placeholder:text-gray-500"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">Loading chats...</div>
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
                                    "flex items-center gap-3 p-3 border-b border-border/40 text-left hover:bg-[#f5f6f6] transition-colors w-full",
                                    selectedPhone === chat.phone_number && "bg-[#f0f2f5]"
                                )}
                            >
                                <div className="h-12 w-12 rounded-full bg-[#dfe5e7] flex items-center justify-center shrink-0">
                                    {chat.contact_type === 'vendor' ? (
                                        <Store className="w-6 h-6 text-orange-500" />
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-[#8696a0]">
                                            <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clipRule="evenodd" />
                                        </svg>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-center mb-1 gap-2">
                                        <span className="flex items-center gap-1.5 min-w-0">
                                            <span className="font-medium text-[15px] text-[#111b21] truncate min-w-0">
                                                {chat.contact_name || chat.phone_number}
                                            </span>
                                            <ContactTypeBadge type={chat.contact_type} className="shrink-0" />
                                        </span>
                                        <span className="flex items-center gap-1 shrink-0">
                                            {reply && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-label="Belum dibalas" />}
                                            <span className={cn("text-[12px]", reply ? "text-emerald-600 font-semibold" : "text-[#667781]")}>
                                                {formatTime(chat.last_message_at)}
                                            </span>
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <p className={cn("text-[13px] truncate leading-5", reply ? "text-[#111b21] font-medium" : "text-[#667781]")}>
                                            {chat.last_message}
                                        </p>
                                        {isWindowExpired(chat.last_inbound_at) && (
                                            <span
                                                title="Lebih dari 24 jam sejak pesan terakhir customer. Balasan biasa akan ditolak Meta (kode 131047) — pakai template message."
                                                className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 text-[10px] font-medium leading-none"
                                            >
                                                <Clock className="h-2.5 w-2.5" />
                                                Perlu template
                                            </span>
                                        )}
                                    </div>
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
