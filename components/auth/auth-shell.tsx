import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import { Ticket, MessageSquare, Radio, ShieldCheck } from 'lucide-react';

// Same display + rail fonts as the landing hero, so the front door matches the
// marketing site exactly.
const spaceGrotesk = Space_Grotesk({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700'],
    variable: '--font-display',
});
const jetbrainsMono = JetBrains_Mono({
    subsets: ['latin'],
    weight: ['400', '500', '600'],
    variable: '--font-mono',
});

// Signature: a compact live pipeline rail — the EO's ops board — echoing the
// landing's hero. Stage colors match the dashboard's pipeline.
const RAIL: { label: string; count: number; color: string; active?: boolean }[] = [
    { label: 'Quoted', count: 5, color: '#FBBF24' },
    { label: 'Booked', count: 2, color: '#22D3EE', active: true },
    { label: 'Won', count: 6, color: '#34D399' },
];
const RAIL_MAX = 6;

const gridWash = {
    backgroundImage:
        'linear-gradient(#B8862F 1px, transparent 1px), linear-gradient(90deg, #B8862F 1px, transparent 1px)',
    backgroundSize: '46px 46px',
};

export function AuthShell({
    eyebrow,
    title,
    subtitle,
    children,
}: {
    eyebrow: string;
    title: string;
    subtitle: string;
    children: React.ReactNode;
}) {
    return (
        <main
            className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} min-h-screen bg-[#0B0B0E] text-[#F4F1E9] selection:bg-[#E6B450]/25 lg:grid lg:grid-cols-[1.05fr_0.95fr]`}
        >
            {/* ── Brand panel (lg+) ─────────────────────────────────────── */}
            <aside className="relative hidden overflow-hidden border-r border-[#B8862F]/20 p-10 lg:flex lg:flex-col lg:justify-between xl:p-14">
                <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.04]" style={gridWash} />

                <Wordmark />

                <div className="relative z-10 max-w-md">
                    <h1 className="font-display text-[clamp(2rem,3.3vw,3rem)] leading-[1.05] font-bold tracking-tight">
                        Dari chat WhatsApp,{' '}
                        <span className="text-[#E6B450]">jadi acara ter-booking.</span>
                    </h1>

                    {/* Live pipeline rail */}
                    <div className="mt-8 overflow-hidden rounded-xl border border-[#B8862F]/30 bg-[#16161C] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.85)]">
                        <div className="flex items-center justify-between border-b border-[#B8862F]/20 px-4 py-3">
                            <span className="font-rail text-[11px] tracking-[0.22em] text-[#8B8A94] uppercase">
                                Pipeline
                                <span className="ml-1.5 tracking-normal text-[#8B8A94]/60 normal-case">
                                    / Lead
                                </span>
                            </span>
                            <span className="font-rail inline-flex items-center gap-2 text-[11px] tracking-[0.18em] text-[#34D399] uppercase">
                                <Radio className="cue-live h-3.5 w-3.5" /> Live
                            </span>
                        </div>

                        <ul>
                            {RAIL.map((s) => (
                                <li
                                    key={s.label}
                                    className={`relative flex items-center gap-3 border-b border-[#B8862F]/10 px-4 py-2.5 last:border-b-0 ${
                                        s.active ? 'bg-[#E6B450]/[0.06]' : ''
                                    }`}
                                >
                                    {s.active && (
                                        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-[#E6B450]" />
                                    )}
                                    <span
                                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                                        style={{ backgroundColor: s.color, boxShadow: `0 0 10px ${s.color}66` }}
                                    />
                                    <span className="font-rail w-20 shrink-0 text-sm tracking-[0.06em] uppercase">
                                        {s.label}
                                    </span>
                                    <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[#0B0B0E]">
                                        <span
                                            className="absolute inset-y-0 left-0 rounded-full"
                                            style={{ width: `${(s.count / RAIL_MAX) * 100}%`, backgroundColor: s.color }}
                                        />
                                    </span>
                                    <span
                                        className="font-rail w-5 shrink-0 text-right text-sm font-medium"
                                        style={{ color: s.color }}
                                    >
                                        {s.count}
                                    </span>
                                </li>
                            ))}
                        </ul>

                        <div className="flex items-center gap-3 border-t border-[#B8862F]/20 px-4 py-3">
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[#34D399]/15">
                                <MessageSquare className="h-3.5 w-3.5 text-[#34D399]" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="font-rail text-[10px] tracking-[0.16em] text-[#8B8A94] uppercase">
                                    Lead baru dari WhatsApp
                                </p>
                                <p className="truncate text-sm">Budi · Wedding 300 pax</p>
                            </div>
                            <span className="font-rail shrink-0 text-[10px] tracking-[0.18em] text-[#22D3EE] uppercase">
                                → Booked
                            </span>
                        </div>
                    </div>
                </div>

                <div className="font-rail relative z-10 flex items-center gap-2 text-[11px] tracking-[0.18em] text-[#8B8A94] uppercase">
                    <ShieldCheck className="h-3.5 w-3.5 text-[#E6B450]" /> Data tiap EO terisolasi penuh
                </div>
            </aside>

            {/* ── Form panel ────────────────────────────────────────────── */}
            <div className="flex min-h-screen flex-col justify-center px-6 py-12 sm:px-10">
                <div className="mx-auto w-full max-w-sm">
                    <div className="mb-9 lg:hidden">
                        <Wordmark />
                    </div>

                    <p className="font-rail text-[11px] tracking-[0.22em] text-[#E6B450] uppercase">{eyebrow}</p>
                    <h2 className="font-display mt-2.5 text-3xl font-bold tracking-tight">{title}</h2>
                    <p className="mt-2 text-sm text-[#8B8A94]">{subtitle}</p>

                    <div className="mt-8">{children}</div>
                </div>
            </div>
        </main>
    );
}

function Wordmark() {
    return (
        <div className="relative z-10 flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-md border border-[#B8862F]/40 bg-[#16161C]">
                <Ticket className="h-[18px] w-[18px] text-[#E6B450]" />
            </span>
            <span className="font-display text-lg font-semibold tracking-tight">Helat</span>
            <span className="font-rail ml-0.5 text-[10px] tracking-[0.18em] text-[#8B8A94] uppercase">
                by Sailendra
            </span>
        </div>
    );
}
