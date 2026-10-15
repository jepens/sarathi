'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Chat {
    phone_number: string;
    contact_name: string | null;
    last_message: string;
    last_message_at: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id: string;
    phone_number: string;
    role: string;
    content: string;
    created_at: string;
}

export default function DebugChatsPage() {
    const [chats, setChats] = useState<Chat[]>([]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const supabase = createClient();

    useEffect(() => {
        const fetchData = async () => {
            // Fetch all chats
            const { data: chatsData, error: chatsError } = await supabase
                .from('whatsapp_chats')
                .select('*')
                .order('last_message_at', { ascending: false });

            if (chatsError) {
                console.error('Error fetching chats:', chatsError);
            } else {
                setChats(chatsData || []);
            }

            // Fetch all messages (last 50)
            const { data: messagesData, error: messagesError } = await supabase
                .from('whatsapp_messages')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(50);

            if (messagesError) {
                console.error('Error fetching messages:', messagesError);
            } else {
                setMessages(messagesData || []);
            }

            setLoading(false);
        };

        fetchData();

        // Auto-refresh every 5 seconds
        const interval = setInterval(fetchData, 5000);

        return () => clearInterval(interval);
    }, [supabase]);

    if (loading) {
        return <div className="p-8">Loading...</div>;
    }

    return (
        <div className="p-8 space-y-6">
            <h1 className="text-3xl font-bold">Debug: WhatsApp Chats & Messages</h1>

            <Card>
                <CardHeader>
                    <CardTitle>WhatsApp Chats ({chats.length})</CardTitle>
                    <CardDescription>All entries in whatsapp_chats table</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b">
                                    <th className="text-left p-2">Phone Number</th>
                                    <th className="text-left p-2">Contact Name</th>
                                    <th className="text-left p-2">Last Message</th>
                                    <th className="text-left p-2">Last Message At</th>
                                    <th className="text-left p-2">Created At</th>
                                </tr>
                            </thead>
                            <tbody>
                                {chats.map((chat) => (
                                    <tr key={chat.phone_number} className="border-b hover:bg-muted/50">
                                        <td className="p-2 font-mono text-xs">{chat.phone_number}</td>
                                        <td className="p-2">{chat.contact_name || '-'}</td>
                                        <td className="p-2 max-w-xs truncate">{chat.last_message}</td>
                                        <td className="p-2 text-xs">{new Date(chat.last_message_at).toLocaleString()}</td>
                                        <td className="p-2 text-xs">{new Date(chat.created_at).toLocaleString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {chats.length === 0 && (
                            <div className="text-center p-4 text-muted-foreground">No chats found</div>
                        )}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Recent Messages ({messages.length})</CardTitle>
                    <CardDescription>Last 50 messages from whatsapp_messages table</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b">
                                    <th className="text-left p-2">Phone Number</th>
                                    <th className="text-left p-2">Role</th>
                                    <th className="text-left p-2">Content</th>
                                    <th className="text-left p-2">Created At</th>
                                </tr>
                            </thead>
                            <tbody>
                                {messages.map((msg) => (
                                    <tr key={msg.id} className="border-b hover:bg-muted/50">
                                        <td className="p-2 font-mono text-xs">{msg.phone_number}</td>
                                        <td className="p-2">
                                            <span className={`px-2 py-1 rounded text-xs ${msg.role === 'user' ? 'bg-blue-100 text-blue-800' :
                                                    msg.role === 'assistant' ? 'bg-green-100 text-green-800' :
                                                        'bg-yellow-100 text-yellow-800'
                                                }`}>
                                                {msg.role}
                                            </span>
                                        </td>
                                        <td className="p-2 max-w-md truncate">{msg.content}</td>
                                        <td className="p-2 text-xs">{new Date(msg.created_at).toLocaleString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {messages.length === 0 && (
                            <div className="text-center p-4 text-muted-foreground">No messages found</div>
                        )}
                    </div>
                </CardContent>
            </Card>

            <div className="text-xs text-muted-foreground">
                Auto-refreshes every 5 seconds
            </div>
        </div>
    );
}
