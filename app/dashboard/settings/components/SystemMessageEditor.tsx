'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Loader2, Save, RefreshCw } from 'lucide-react';

interface SystemMessage {
    id: string;
    name: string;
    content: string;
    is_active: boolean;
    description: string;
    created_at: string;
    updated_at: string;
}

export function SystemMessageEditor() {
    const [systemMessage, setSystemMessage] = useState<SystemMessage | null>(null);
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const fetchSystemMessage = useCallback(async () => {
        try {
            setLoading(true);
            const response = await fetch('/api/system-message');

            if (!response.ok) {
                throw new Error('Failed to fetch system message');
            }

            const data = await response.json();
            setSystemMessage(data);
            setContent(data.content);
        } catch (error) {
            console.error('Error fetching system message:', error);
            toast.error('Failed to load system message');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSystemMessage();
    }, [fetchSystemMessage]);

    const handleSave = async () => {
        if (!systemMessage) return;

        try {
            setSaving(true);

            const response = await fetch('/api/system-message', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    id: systemMessage.id,
                    content,
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to update system message');
            }

            const updatedData = await response.json();
            setSystemMessage(updatedData);

            toast.success('System message updated successfully');
        } catch (error) {
            console.error('Error updating system message:', error);
            toast.error('Failed to update system message');
        } finally {
            setSaving(false);
        }
    };

    const handleReset = () => {
        if (systemMessage) {
            setContent(systemMessage.content);
            toast.info('Changes have been discarded');
        }
    };

    if (loading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>AI System Message</CardTitle>
                    <CardDescription>
                        Configure the AI persona and behavior
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    const hasChanges = content !== systemMessage?.content;

    return (
        <Card>
            <CardHeader>
                <CardTitle>AI System Message</CardTitle>
                <CardDescription>
                    Configure the AI persona and behavior for Sahabat UMKM
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <label className="text-sm font-medium">
                        System Message Content
                    </label>
                    <Textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="Enter system message..."
                        className="min-h-[400px] font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                        This message defines how the AI will behave and respond to users.
                        Use Markdown formatting for better structure.
                    </p>
                </div>

                {systemMessage && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-4">
                        <div>
                            <span className="font-medium">Profile:</span> {systemMessage.name} |
                            <span className="ml-2 font-medium">Last updated:</span> {new Date(systemMessage.updated_at).toLocaleString('id-ID')}
                        </div>
                    </div>
                )}

                <div className="flex gap-2 pt-4 border-t">
                    <Button
                        onClick={handleSave}
                        disabled={saving || !hasChanges}
                        className="flex-1"
                    >
                        {saving ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Save className="mr-2 h-4 w-4" />
                                Save Changes
                            </>
                        )}
                    </Button>
                    <Button
                        onClick={handleReset}
                        variant="outline"
                        disabled={!hasChanges}
                    >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Reset
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
