'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, MoreVertical, Phone, Video } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    created_at: string;
}

interface ChatWindowProps {
    phoneNumber: string;
}

export function ChatWindow({ phoneNumber }: ChatWindowProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMessage, setNewMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [contactName, setContactName] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const supabase = createClient();

    const fetchMessages = useCallback(async () => {
        // Fetch contact info
        const { data: contactData } = await supabase
            .from('whatsapp_chats')
            .select('contact_name')
            .eq('phone_number', phoneNumber)
            .single();

        if (contactData) {
            setContactName(contactData.contact_name);
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
    }, [phoneNumber, supabase]);

    useEffect(() => {
        fetchMessages();

        // Subscribe to real-time changes
        const channel = supabase
            .channel(`whatsapp_messages:${phoneNumber}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'whatsapp_messages',
                filter: `phone_number=eq.${phoneNumber}`
            }, (payload) => {
                setMessages(prev => [...prev, payload.new as Message]);
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
        if (scrollRef.current) {
            scrollRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    const handleSend = async () => {
        if (!newMessage.trim()) return;

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

            if (!response.ok) throw new Error('Failed to send message');

            setNewMessage('');

        } catch (error) {
            console.error('Error sending message:', error);
            toast.error('Failed to send message');
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

    return (
        <div className="flex flex-col h-full bg-[#efeae2]">
            <div className="p-3 border-b flex justify-between items-center bg-[#f0f2f5] shadow-sm flex-shrink-0">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-[#dfe5e7] flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-[#8696a0]">
                            <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <div>
                        <h2 className="font-semibold text-sm text-[#111b21]">{contactName || phoneNumber}</h2>
                        <p className="text-xs text-[#667781]">Online</p>
                    </div>
                </div>
                <div className="flex gap-4 text-[#54656f]">
                    <Video className="h-5 w-5 cursor-pointer hover:text-[#111b21]" />
                    <Phone className="h-5 w-5 cursor-pointer hover:text-[#111b21]" />
                    <MoreVertical className="h-5 w-5 cursor-pointer hover:text-[#111b21]" />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
                <div className="flex flex-col space-y-4 pb-4">
                    {Object.entries(groupedMessages).map(([date, msgs]) => (
                        <div key={date} className="flex flex-col space-y-4">
                            <div className="flex justify-center sticky top-2">
                                <span className="bg-white/90 shadow-sm rounded-lg px-3 py-1 text-xs text-[#667781] font-medium">
                                    {new Date(date).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                </span>
                            </div>
                            {msgs.map((msg) => {
                                if (msg.role === 'system') {
                                    return (
                                        <div key={msg.id} className="flex justify-center my-2">
                                            <span className="bg-[#ffeecd] text-yellow-800 text-xs px-3 py-1 rounded-lg text-center shadow-sm max-w-[80%]">
                                                {msg.content}
                                            </span>
                                        </div>
                                    );
                                }

                                return (
                                    <div
                                        key={msg.id}
                                        className={cn(
                                            "max-w-[80%] rounded-lg p-2 px-3 text-sm shadow-sm relative",
                                            msg.role === 'user'
                                                ? "bg-white self-start text-black rounded-tl-none"
                                                : "bg-[#d9fdd3] self-end text-black rounded-tr-none"
                                        )}
                                    >
                                        <p className="leading-relaxed">{msg.content}</p>
                                        <span className="text-[10px] float-right ml-2 mt-1 text-zinc-500">
                                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                    <div ref={scrollRef} />
                </div>
            </div>

            <div className="p-3 bg-[#f0f2f5] flex items-center gap-2 flex-shrink-0">
                <form
                    onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                    className="flex gap-2 w-full"
                >
                    <Input
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Type a message"
                        disabled={sending}
                        className="bg-white border-none focus-visible:ring-0 rounded-lg py-6 text-black"
                    />
                    <Button
                        type="submit"
                        size="icon"
                        disabled={sending || !newMessage.trim()}
                        className={cn(
                            "h-12 w-12 rounded-lg shrink-0 transition-all",
                            newMessage.trim() ? "bg-[#00a884] hover:bg-[#008f6f]" : "bg-transparent text-muted-foreground hover:bg-transparent"
                        )}
                    >
                        <Send className={cn("h-5 w-5", newMessage.trim() ? "text-white" : "text-muted-foreground")} />
                    </Button>
                </form>
            </div>
        </div>
    );
}
