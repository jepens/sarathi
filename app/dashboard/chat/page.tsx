'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Loader2, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '../../../components/ui/textarea';

interface Message {
    role: 'user' | 'assistant';
    content: string;
    sources?: string[];
}

export default function ChatPage() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage: Message = { role: 'user', content: input };
        // Use the snapshot for the API call so the new user message isn't echoed back.
        const historySnapshot = messages;
        setMessages((prev) => [...prev, userMessage, { role: 'assistant', content: '' }]);
        const submittedInput = input;
        setInput('');
        setIsLoading(true);

        const appendDelta = (delta: string) => {
            setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') {
                    next[next.length - 1] = { ...last, content: last.content + delta };
                }
                return next;
            });
        };

        const setAssistantContent = (content: string, sources?: string[]) => {
            setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') {
                    next[next.length - 1] = { ...last, content, sources };
                }
                return next;
            });
        };

        const setSources = (sources: string[]) => {
            setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') {
                    next[next.length - 1] = { ...last, sources };
                }
                return next;
            });
        };

        try {
            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: submittedInput,
                    history: historySnapshot,
                }),
            });

            if (!response.ok || !response.body) {
                throw new Error('Failed to get response');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIdx;
                while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIdx).trim();
                    buffer = buffer.slice(newlineIdx + 1);
                    if (!line) continue;
                    let event: { type: string; [k: string]: unknown };
                    try {
                        event = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    if (event.type === 'text' && typeof event.delta === 'string') {
                        appendDelta(event.delta);
                    } else if (event.type === 'sources' && Array.isArray(event.sources)) {
                        setSources(event.sources as string[]);
                    } else if (event.type === 'error') {
                        const errMsg =
                            typeof event.error === 'string'
                                ? event.error
                                : 'Internal error';
                        setAssistantContent(`Maaf, terjadi kesalahan: ${errMsg}`);
                        // Release the underlying body so the server-side
                        // request.signal fires and OpenAI generation stops.
                        await reader.cancel().catch(() => {});
                        return;
                    }
                    // tool / done events are advisory — no UI change for now.
                }
            }
        } catch (error) {
            console.error('Chat error:', error);
            setAssistantContent('Maaf, terjadi kesalahan. Silakan coba lagi.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
        }
    };

    return (
        <div className="flex h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-4rem)] flex-col">
            {/* Header */}
            <div className="border-b bg-background/80 backdrop-blur-sm">
                <div className="px-4 py-3 md:px-6 md:py-4">
                    <h1 className="text-lg md:text-2xl font-semibold tracking-tight">Chat dengan AI</h1>
                    <p className="text-sm text-muted-foreground">
                        Tanyakan tentang bisnis Anda berdasarkan knowledge base
                    </p>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
                {messages.length === 0 ? (
                    <div className="flex h-full items-center justify-center">
                        <div className="text-center">
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border bg-muted">
                                <BookOpen className="h-6 w-6 text-muted-foreground" />
                            </div>
                            <h3 className="mb-2 text-lg font-medium">Mulai Percakapan</h3>
                            <p className="text-sm text-muted-foreground">
                                Tanyakan apa saja tentang dokumen yang sudah Anda upload
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {messages.map((message, index) => (
                            <div
                                key={index}
                                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'
                                    }`}
                            >
                                <div
                                    className={`max-w-[80%] rounded-lg px-4 py-3 ${message.role === 'user'
                                        ? 'bg-primary text-primary-foreground'
                                        : 'border bg-muted'
                                        }`}
                                >
                                    <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                                    {message.sources && message.sources.length > 0 && (
                                        <div className="mt-2 border-t pt-2">
                                            <p className="text-xs text-muted-foreground">
                                                Sumber: {message.sources.join(', ')}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex justify-start">
                                <div className="max-w-[80%] rounded-lg border bg-muted px-4 py-3">
                                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                )}
            </div>

            {/* Input */}
            <div className="border-t bg-background/80 backdrop-blur-sm">
                <form onSubmit={handleSubmit} className="px-4 py-3 md:px-6 md:py-4">
                    <div className="flex gap-2">
                        <Textarea
                            value={input}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Ketik pertanyaan Anda..."
                            className="min-h-[60px] resize-none"
                            disabled={isLoading}
                        />
                        <Button
                            type="submit"
                            size="icon"
                            disabled={!input.trim() || isLoading}
                            className="h-[60px] w-12 md:w-[60px]"
                        >
                            {isLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Send className="h-4 w-4" />
                            )}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
