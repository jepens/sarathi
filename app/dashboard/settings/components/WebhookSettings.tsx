'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CheckCircle2, XCircle, Save, Loader2, Copy, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { updateWebhookSettings } from '../actions';
import { toast } from "sonner";
import { SecureInput } from './SecureInput';

interface WebhookSettingsProps {
    initialWebhookUrl: string;
    initialVerifyToken: string;
    initialAccessToken: string;
    initialPhoneNumberId: string;
    initialAppSecret: string;
    isConfigured: boolean;
}

export function WebhookSettings({
    initialWebhookUrl,
    initialVerifyToken,
    initialAccessToken,
    initialPhoneNumberId,
    initialAppSecret,
    isConfigured
}: WebhookSettingsProps) {
    const [webhookUrl, setWebhookUrl] = useState(initialWebhookUrl);
    const [verifyToken, setVerifyToken] = useState(initialVerifyToken);
    const [accessToken, setAccessToken] = useState(initialAccessToken);
    const [phoneNumberId, setPhoneNumberId] = useState(initialPhoneNumberId);
    const [appSecret, setAppSecret] = useState(initialAppSecret);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const handleCopy = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success("Copied to clipboard");
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);

        try {
            const formData = new FormData();
            formData.append('webhookUrl', webhookUrl);
            formData.append('verifyToken', verifyToken);
            formData.append('accessToken', accessToken);
            formData.append('phoneNumberId', phoneNumberId);
            formData.append('appSecret', appSecret);

            await updateWebhookSettings(formData);

            toast.success("Settings updated successfully");
            setIsEditing(false);
        } catch {
            toast.error("Failed to save settings");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    WhatsApp Integration
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
                    Configure your WhatsApp Business API webhook connection.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="webhook-url">Webhook URL</Label>
                            {!isEditing && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-xs"
                                    onClick={() => handleCopy(webhookUrl)}
                                >
                                    <Copy className="w-3 h-3 mr-1" /> Copy
                                </Button>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <Input
                                id="webhook-url"
                                value={webhookUrl}
                                onChange={(e) => setWebhookUrl(e.target.value)}
                                disabled={!isEditing}
                                className="font-mono text-sm"
                                placeholder="https://your-domain.com/api/webhook/whatsapp"
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Enter this URL in the Meta Developer Portal configuration.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="verify-token">Verify Token</Label>
                            {!isEditing && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-xs"
                                    onClick={() => handleCopy(verifyToken)}
                                >
                                    <Copy className="w-3 h-3 mr-1" /> Copy
                                </Button>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <Input
                                id="verify-token"
                                value={verifyToken}
                                onChange={(e) => setVerifyToken(e.target.value)}
                                disabled={!isEditing}
                                className="font-mono text-sm"
                                type="text"
                                placeholder="Enter a secure token"
                            />
                            {isEditing && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => setVerifyToken(Math.random().toString(36).slice(-8))}
                                    title="Generate Random Token"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                </Button>
                            )}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="access-token">Access Token 🔐</Label>
                        <SecureInput
                            id="access-token"
                            value={accessToken}
                            onChange={setAccessToken}
                            disabled={!isEditing}
                            placeholder="Enter WhatsApp Access Token"
                        />
                        <p className="text-xs text-muted-foreground">
                            Get this from Meta Developer Portal → WhatsApp → API Setup
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="phone-number-id">Phone Number ID</Label>
                        <Input
                            id="phone-number-id"
                            value={phoneNumberId}
                            onChange={(e) => setPhoneNumberId(e.target.value)}
                            disabled={!isEditing}
                            className="font-mono text-sm"
                            placeholder="Enter Phone Number ID"
                        />
                        <p className="text-xs text-muted-foreground">
                            Find this in Meta Developer Portal → WhatsApp → API Setup
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="app-secret">App Secret 🔐 (Optional)</Label>
                        <SecureInput
                            id="app-secret"
                            value={appSecret}
                            onChange={setAppSecret}
                            disabled={!isEditing}
                            placeholder="Enter App Secret for webhook validation"
                        />
                        <p className="text-xs text-muted-foreground">
                            Used for webhook signature validation (recommended for production)
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
                                        setWebhookUrl(initialWebhookUrl);
                                        setVerifyToken(initialVerifyToken);
                                        setAccessToken(initialAccessToken);
                                        setPhoneNumberId(initialPhoneNumberId);
                                        setAppSecret(initialAppSecret);
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
