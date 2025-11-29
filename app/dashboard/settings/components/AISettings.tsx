'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CheckCircle2, XCircle, Save, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { updateAISettings } from '../actions';
import { toast } from "sonner";
import { SecureInput } from './SecureInput';

interface AISettingsProps {
    initialOpenAIKey: string;
    isConfigured: boolean;
}

export function AISettings({ initialOpenAIKey, isConfigured }: AISettingsProps) {
    const [openAIKey, setOpenAIKey] = useState(initialOpenAIKey);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);

        try {
            const formData = new FormData();
            formData.append('openAIKey', openAIKey);

            await updateAISettings(formData);

            toast.success("AI settings updated successfully");
            setIsEditing(false);
        } catch {
            toast.error("Failed to save AI settings");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    AI Configuration
                    {isConfigured ? (
                        <Badge variant="default" className="bg-green-500/15 text-green-500 hover:bg-green-500/25 border-green-500/20">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                        </Badge>
                    ) : (
                        <Badge variant="destructive" className="bg-red-500/15 text-red-500 hover:bg-red-500/25 border-red-500/20">
                            <XCircle className="w-3 h-3 mr-1" /> Inactive
                        </Badge>
                    )}
                </CardTitle>
                <CardDescription>
                    Configure your OpenAI API key for AI Chat and RAG features.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="openai-key">OpenAI API Key 🔐</Label>
                        <SecureInput
                            id="openai-key"
                            value={openAIKey}
                            onChange={setOpenAIKey}
                            disabled={!isEditing}
                            placeholder="sk-..."
                        />
                        <p className="text-xs text-muted-foreground">
                            Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline">OpenAI Platform</a>
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        {isEditing ? (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        setIsEditing(false);
                                        setOpenAIKey(initialOpenAIKey);
                                    }}
                                    disabled={isSaving}
                                >
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={isSaving}>
                                    {isSaving ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...
                                        </>
                                    ) : (
                                        <>
                                            <Save className="w-4 h-4 mr-2" /> Save Changes
                                        </>
                                    )}
                                </Button>
                            </>
                        ) : (
                            <Button type="button" onClick={() => setIsEditing(true)}>
                                Edit Configuration
                            </Button>
                        )}
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}
