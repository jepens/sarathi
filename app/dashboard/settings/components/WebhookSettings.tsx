'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Copy, Webhook } from "lucide-react";
import { toast } from "sonner";

interface WebhookSettingsProps {
    webhookUrl: string;
    verifyToken: string;
}

// Read-only panel. The Callback URL + Verify Token are platform-global (the
// webhook routes inbound messages by phone_number_id, so every tenant points
// their Meta app at the same endpoint with the same verify token). They are
// not tenant-editable — what makes this org's bot work is the per-tenant Meta
// credentials in the WhatsApp Credentials card above. Here we just surface the
// two values to copy into Meta → WhatsApp → Configuration.
export function WebhookSettings({ webhookUrl, verifyToken }: WebhookSettingsProps) {
    const copy = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success("Disalin");
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Webhook className="h-4 w-4" /> Webhook Meta
                </CardTitle>
                <CardDescription>
                    Di Meta App → WhatsApp → Configuration, isi Callback URL & Verify
                    Token berikut, lalu subscribe ke field <span className="font-mono">messages</span>.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <ReadOnlyField
                    id="webhook-url"
                    label="Callback URL"
                    value={webhookUrl}
                    onCopy={copy}
                />
                <ReadOnlyField
                    id="verify-token"
                    label="Verify Token"
                    value={verifyToken}
                    onCopy={copy}
                />
            </CardContent>
        </Card>
    );
}

function ReadOnlyField({
    id,
    label,
    value,
    onCopy,
}: {
    id: string;
    label: string;
    value: string;
    onCopy: (text: string) => void;
}) {
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <Label htmlFor={id}>{label}</Label>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => onCopy(value)}
                >
                    <Copy className="w-3 h-3 mr-1" /> Salin
                </Button>
            </div>
            <Input
                id={id}
                value={value}
                readOnly
                className="font-mono text-xs sm:text-sm"
            />
        </div>
    );
}
