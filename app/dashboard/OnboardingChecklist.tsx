'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Circle, ArrowRight, Copy, Check, Webhook } from 'lucide-react';

interface OnboardingStatus {
    show: boolean;
    steps: { profile: boolean; whatsapp: boolean; knowledge: boolean };
    webhookUrl: string | null;
    verifyToken: string | null;
}

const STEP_DEFS = [
    {
        key: 'profile',
        title: 'Lengkapi Profil Bisnis',
        desc: 'Nama bisnis, nama asisten, dan nomor hand-off — dipakai bot saat menyapa klien & meneruskan ke tim Anda.',
        href: '/dashboard/settings',
        cta: 'Buka Profil',
    },
    {
        key: 'whatsapp',
        title: 'Hubungkan WhatsApp',
        desc: 'Masukkan kredensial Meta (Phone Number ID, Access Token, App Secret) di Settings → WhatsApp.',
        href: '/dashboard/settings',
        cta: 'Atur kredensial',
    },
    {
        key: 'knowledge',
        title: 'Isi Knowledge Base',
        desc: 'Upload brosur/paket atau tulis di editor — ini sumber jawaban bot Anda.',
        href: '/dashboard/knowledge',
        cta: 'Tambah materi',
    },
] as const;

export function OnboardingChecklist() {
    const [status, setStatus] = useState<OnboardingStatus | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const r = await fetch('/api/onboarding/status', { cache: 'no-store' });
                if (r.ok) setStatus(await r.json());
            } catch {
                /* non-fatal — just don't show the checklist */
            }
        })();
    }, []);

    if (!status || !status.show) return null;

    const steps = status.steps as Record<string, boolean>;
    const doneCount = STEP_DEFS.filter((s) => steps[s.key]).length;

    const copy = async (label: string, value: string | null) => {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            setCopied(label);
            setTimeout(() => setCopied(null), 1500);
        } catch {
            /* clipboard blocked — ignore */
        }
    };

    return (
        <Card className="border-primary/30 bg-primary/[0.03]">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    Selesaikan setup Helat Anda
                    <span className="text-sm font-normal text-muted-foreground">
                        {doneCount}/{STEP_DEFS.length} langkah
                    </span>
                </CardTitle>
                <CardDescription>
                    Beberapa langkah agar asisten WhatsApp Anda siap melayani klien.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {STEP_DEFS.map((s) => {
                    const done = steps[s.key];
                    return (
                        <div
                            key={s.key}
                            className="flex items-start gap-3 rounded-lg border p-3"
                        >
                            {done ? (
                                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                            ) : (
                                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                            )}
                            <div className="min-w-0 flex-1">
                                <p
                                    className={`text-sm font-medium ${done ? 'text-muted-foreground line-through' : ''}`}
                                >
                                    {s.title}
                                </p>
                                <p className="text-xs text-muted-foreground">{s.desc}</p>
                            </div>
                            {!done && (
                                <Link href={s.href} className="shrink-0">
                                    <Button size="sm" variant="outline">
                                        {s.cta} <ArrowRight className="h-3 w-3" />
                                    </Button>
                                </Link>
                            )}
                        </div>
                    );
                })}

                {/* Manual Meta step — can't be auto-detected, so show exactly what
                    to paste into the Meta App webhook config. The Callback URL &
                    Verify Token are shared across tenants (the webhook routes by
                    phone_number_id). */}
                <div className="space-y-2 rounded-lg border border-dashed p-3">
                    <p className="flex items-center gap-2 text-sm font-medium">
                        <Webhook className="h-4 w-4" /> Arahkan webhook Meta ke Helat
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Di Meta App → WhatsApp → Configuration, isi Callback URL &
                        Verify Token berikut, lalu subscribe ke field{' '}
                        <span className="font-mono">messages</span>.
                    </p>
                    <CopyRow label="Callback URL" value={status.webhookUrl} copied={copied} onCopy={copy} />
                    <CopyRow label="Verify Token" value={status.verifyToken} copied={copied} onCopy={copy} />
                </div>
            </CardContent>
        </Card>
    );
}

function CopyRow({
    label,
    value,
    copied,
    onCopy,
}: {
    label: string;
    value: string | null;
    copied: string | null;
    onCopy: (label: string, value: string | null) => void;
}) {
    return (
        <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {value || 'belum diatur'}
            </code>
            <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 px-2"
                onClick={() => onCopy(label, value)}
                disabled={!value}
            >
                {copied === label ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                    <Copy className="h-3.5 w-3.5" />
                )}
            </Button>
        </div>
    );
}
