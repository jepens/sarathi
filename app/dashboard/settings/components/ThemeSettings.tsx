'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Sun, Moon, Check, Palette } from 'lucide-react';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

// Read "mounted" without a setState-in-effect (the repo lints against that).
// useSyncExternalStore renders the server snapshot (false) during hydration —
// matching the server — then flips to the client snapshot (true) on commit, so
// there is no hydration mismatch when we later highlight the active theme.
const emptySubscribe = () => () => {};

// Each option shows a little WhatsApp-style chat preview (an incoming + an
// outgoing bubble on that theme's paper) so the choice is visual, like WhatsApp.
// Inline hex is intentional: the swatch illustrates the *option*, not the app's
// current theme, so it must NOT react to .dark.
const OPTIONS = [
    {
        value: 'system',
        label: 'Sistem',
        desc: 'Ikuti perangkat',
        Icon: Monitor,
        preview: { bg: 'linear-gradient(135deg, #efeae2 0 50%, #0b141a 50% 100%)', bin: '#ffffff', bout: '#005c4b' },
    },
    {
        value: 'light',
        label: 'Terang',
        desc: 'Selalu terang',
        Icon: Sun,
        preview: { bg: '#efeae2', bin: '#ffffff', bout: '#d9fdd3' },
    },
    {
        value: 'dark',
        label: 'Gelap',
        desc: 'Selalu gelap',
        Icon: Moon,
        preview: { bg: '#0b141a', bin: '#202c33', bout: '#005c4b' },
    },
] as const;

export function ThemeSettings() {
    const { theme, setTheme } = useTheme();
    const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
    // Before mount we don't know the stored theme — render with nothing active
    // (identical on server + client) to stay hydration-safe.
    const current = mounted ? theme ?? 'system' : undefined;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Palette className="h-5 w-5 text-emerald-600" />
                    Tema
                </CardTitle>
                <CardDescription>
                    Pilih tampilan aplikasi. <strong>Sistem</strong> otomatis mengikuti pengaturan
                    terang/gelap perangkat Anda. Pilihan ini tersimpan di perangkat ini.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid gap-3 sm:grid-cols-3">
                    {OPTIONS.map(({ value, label, desc, Icon, preview }) => {
                        const active = current === value;
                        return (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setTheme(value)}
                                aria-pressed={active}
                                className={cn(
                                    'relative flex flex-col gap-3 rounded-lg border p-3 text-left transition hover:bg-accent',
                                    active
                                        ? 'border-emerald-500 ring-1 ring-emerald-500'
                                        : 'border-border',
                                )}
                            >
                                {active && (
                                    <Check className="absolute right-2.5 top-2.5 h-4 w-4 text-emerald-500" />
                                )}
                                <div
                                    aria-hidden
                                    className="flex h-14 w-full flex-col justify-center gap-1.5 overflow-hidden rounded-md border px-2.5"
                                    style={{ background: preview.bg }}
                                >
                                    <span className="h-2.5 w-9 rounded-full" style={{ background: preview.bin }} />
                                    <span className="h-2.5 w-12 self-end rounded-full" style={{ background: preview.bout }} />
                                </div>
                                <div className="flex items-center gap-2">
                                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium leading-none">{label}</div>
                                        <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </CardContent>
        </Card>
    );
}
