'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Copy, Webhook } from "lucide-react";
import { toast } from "sonner";

interface WebhookSettingsProps {
    /** null for orgs other than the default org — see below. */
    webhookUrl: string | null;
    verifyToken: string | null;
}

// Read-only panel. The Callback URL + Verify Token are platform-global (the
// webhook routes inbound messages by phone_number_id, so every tenant points
// their Meta app at the same endpoint with the same verify token). They are
// not tenant-editable — what makes this org's bot work is the per-tenant Meta
// credentials in the WhatsApp Credentials card above. Here we just surface the
// two values to copy into Meta → WhatsApp → Configuration.
//
// Only members of the default org (whose env number this webhook serves) get
// the values; for every other org the Sarathi team configures Meta, so the
// page passes nulls and we show a neutral note instead (KEA-27).
export function WebhookSettings({ webhookUrl, verifyToken }: WebhookSettingsProps) {
    const copy = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success("Disalin");
    };

    if (webhookUrl === null || verifyToken === null) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Webhook className="h-4 w-4" /> Webhook Meta
                    </CardTitle>
                    <CardDescription>
                        Webhook WhatsApp untuk organisasi Anda diatur oleh tim Sarathi.
                        Tidak ada yang perlu Anda isi di sini.
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Webhook className="h-4 w-4" /> Webhook Meta
                </CardTitle>
                <CardDescription>
                    Di Meta App → WhatsApp → Configuration, isi Callback URL & Verify
                    Token berikut, lalu subscribe ke field{' '}
                    <span className="font-mono">messages</span>. Bila field{' '}
                    <span className="font-mono">user_id_update</span> sudah muncul di daftar
                    (Meta masih merilisnya bertahap), subscribe juga — ini menjaga kontak
                    tetap tersambung saat customer ganti nomor / memakai username WhatsApp
                    (BSUID). Bila belum ada di daftar, abaikan dulu.
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
