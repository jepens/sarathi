'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Send, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

interface Message {
    role: 'user' | 'assistant';
    content: string;
    sources?: string[];
}

export function TestChatPreview() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [systemMessageName, setSystemMessageName] = useState<string>('');

    const handleSend = async () => {
        if (!input.trim() || loading) return;

        const userMessage = input.trim();
        setInput('');

        // Add user message
        setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
        setLoading(true);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: userMessage,
                    history: messages,
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to get AI response');
            }

            const data = await response.json();

            // Add AI response
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: data.message,
                sources: data.sources || []
            }]);

            // Get current system message name
            if (!systemMessageName) {
                const sysResponse = await fetch('/api/system-message');
                if (sysResponse.ok) {
                    const sysData = await sysResponse.json();
                    setSystemMessageName(sysData.name);
                }
            }
        } catch (error) {
            console.error('Error sending message:', error);
            toast.error('Failed to get AI response');
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: 'Maaf, terjadi kesalahan saat memproses pesan Anda.'
            }]);
        } finally {
            setLoading(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleClear = () => {
        setMessages([]);
        setSystemMessageName('');
        toast.info('Chat preview cleared');
    };

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div className="space-y-1">
                        <CardTitle className="flex items-center gap-2">
                            <MessageSquare className="h-5 w-5" />
                            Test Chat Preview
                        </CardTitle>
                        <CardDescription>
                            Test AI responses with current settings before deploying
                        </CardDescription>
                    </div>
                    {systemMessageName && (
                        <Badge variant="outline" className="flex items-center gap-1">
                            <Sparkles className="h-3 w-3" />
                            {systemMessageName}
                        </Badge>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Info Banner */}
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-sm space-y-2">
                    <p className="text-blue-800 dark:text-blue-200">
                        💡 <strong>Tip:</strong> This sandbox uses the <strong>currently active</strong>{' '}
                        System Message, Knowledge Base, and Products — the same ones the live WhatsApp
                        bot uses. Saving the System Message takes effect for real customers immediately
                        (there is no separate staging).
                    </p>
                    <p className="text-blue-800 dark:text-blue-200">
                        ⚠️ The preview runs without a contact, so data-writing tools (schedule a
                        meeting/Zoom, save lead, create order, hand off to a human) are{' '}
                        <strong>disabled here</strong> — test those in a real WhatsApp chat.
                    </p>
                </div>

                {/* Chat Area */}
                <ScrollArea className="h-[300px] sm:h-[400px] border rounded-lg bg-muted/30 p-4">
                    {messages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                            <MessageSquare className="h-12 w-12 mb-2 opacity-20" />
                            <p className="text-sm">Send a message to test AI responses</p>
                            <p className="text-xs mt-1">Try: &quot;Paket team building apa saja?&quot; atau &quot;Saya cari EO untuk gathering 100 orang di Sentul&quot;</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {messages.map((msg, idx) => (
                                <div
                                    key={idx}
                                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[90%] rounded-lg p-2.5 sm:max-w-[80%] sm:p-3 ${msg.role === 'user'
                                            ? 'bg-blue-600 text-white'
                                            : 'bg-muted border'
                                            }`}
                                    >
                                        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                                        {msg.sources && msg.sources.length > 0 && (
                                            <div className="mt-2 pt-2 border-t">
                                                <p className="text-xs text-muted-foreground mb-1">Sources:</p>
                                                <div className="flex flex-wrap gap-1">
                                                    {msg.sources.map((source, i) => (
                                                        <Badge key={i} variant="secondary" className="text-xs">
                                                            {source}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {loading && (
                                <div className="flex justify-start">
                                    <div className="bg-muted/50 border rounded-lg p-3">
                                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </ScrollArea>

                {/* Input Area */}
                <div className="flex gap-2">
                    <Input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="Type a message to test AI..."
                        disabled={loading}
                        className="flex-1"
                    />
                    <Button onClick={handleSend} disabled={!input.trim() || loading} size="icon">
                        {loading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Send className="h-4 w-4" />
                        )}
                    </Button>
                    {messages.length > 0 && (
                        <Button onClick={handleClear} variant="outline" disabled={loading}>
                            Clear
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
