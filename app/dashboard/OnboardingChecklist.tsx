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
import { CheckCircle2, Circle, ArrowRight } from 'lucide-react';

interface OnboardingStatus {
    show: boolean;
    steps: { profile: boolean; whatsapp: boolean; knowledge: boolean };
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
        // Every org's number is connected by the Sarathi team (2.2d).
        desc: 'Nomor WhatsApp organisasi Anda dihubungkan oleh tim Sarathi. Hubungi tim Sarathi bila belum aktif.',
        href: '/dashboard/settings',
        cta: 'Lihat status',
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

    return (
        <Card className="border-brand-gold/30 bg-brand-gold/[0.04]">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    Selesaikan setup Sarathi Anda
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
            </CardContent>
        </Card>
    );
}
