import { Fraunces } from 'next/font/google';
import { CheckCheck, CalendarCheck, MessageCircle, Bot, ShieldCheck } from 'lucide-react';
import { SignupForm } from './SignupForm';

// Characterful serif for the wordmark + brand headline only; body stays Inter.
const fraunces = Fraunces({
    subsets: ['latin'],
    weight: ['400', '500', '600'],
    style: ['normal', 'italic'],
    variable: '--font-fraunces',
});

const display = { fontFamily: 'var(--font-fraunces), Georgia, serif' };

// Deep "evening event" gradient with warm gold + magenta glows — a deliberate
// colored brand surface, not the flat near-black default.
const brandBg = {
    backgroundImage:
        'radial-gradient(120% 80% at 12% 8%, rgba(192,57,126,0.28), transparent 55%),' +
        'radial-gradient(90% 70% at 92% 100%, rgba(231,193,106,0.20), transparent 50%),' +
        'linear-gradient(150deg, #2A1145 0%, #181A4A 46%, #0B1030 100%)',
};

const FEATURES = [
    { icon: Bot, text: 'Asisten WhatsApp ber-AI membalas & mencatat klien 24/7' },
    { icon: CalendarCheck, text: 'Pipeline lead & kalender acara terisi otomatis' },
    { icon: ShieldCheck, text: 'Data tiap EO terisolasi penuh' },
];

export default function SignupPage() {
    return (
        <main className={`${fraunces.variable} min-h-screen lg:grid lg:grid-cols-[1.05fr_1fr]`}>
            {/* ── Brand panel (lg+) ─────────────────────────────────────── */}
            <aside
                className="relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between"
                style={brandBg}
            >
                <div className="relative z-10">
                    <div className="text-3xl font-semibold tracking-tight" style={display}>
                        Helat
                        <span className="ml-2 align-middle text-sm font-normal text-white/50">
                            by Sailendra
                        </span>
                    </div>
                    <div className="mt-1 h-0.5 w-12 rounded-full bg-[#e7c16a]" />
                </div>

                <div className="relative z-10 max-w-md">
                    <h1 className="text-4xl leading-[1.15] font-light xl:text-5xl" style={display}>
                        Dari chat WhatsApp,
                        <br />
                        jadi acara{' '}
                        <em className="font-medium text-[#e7c16a]" style={display}>
                            ter-booking.
                        </em>
                    </h1>

                    {/* Signature motif: a WhatsApp message resolving into a booked event */}
                    <div className="mt-9 space-y-3">
                        <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.07] p-3 backdrop-blur-sm">
                            <p className="text-sm text-white/90">
                                Halo, mau tanya paket wedding untuk 200 tamu 😊
                            </p>
                            <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-white/45">
                                09:24 <CheckCheck className="h-3 w-3 text-[#7fd0c4]" />
                            </div>
                        </div>

                        <div className="flex items-center gap-2 pl-3 text-xs text-white/45">
                            <MessageCircle className="h-3.5 w-3.5 text-[#e7c16a]" />
                            Asisten Helat menjawab, lalu mencatat lead-nya
                        </div>

                        <div className="ml-auto max-w-[84%] rounded-2xl rounded-br-md border border-[#e7c16a]/25 bg-white/[0.06] p-3.5 backdrop-blur-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium" style={display}>
                                    Wedding · 200 tamu
                                </span>
                                <span className="rounded-full bg-[#e7c16a]/15 px-2 py-0.5 text-[10px] font-medium text-[#e7c16a]">
                                    Ter-booking ✓
                                </span>
                            </div>
                            <div className="mt-1 text-xs text-white/50">12 Jul 2026 · Ballroom</div>
                        </div>
                    </div>
                </div>

                <ul className="relative z-10 space-y-2.5">
                    {FEATURES.map(({ icon: Icon, text }) => (
                        <li key={text} className="flex items-center gap-3 text-sm text-white/75">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/8 text-[#e7c16a]">
                                <Icon className="h-3.5 w-3.5" />
                            </span>
                            {text}
                        </li>
                    ))}
                </ul>
            </aside>

            {/* ── Form panel ────────────────────────────────────────────── */}
            <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-10">
                <div className="w-full max-w-md">
                    {/* Compact brand header for mobile (brand panel is hidden) */}
                    <div className="mb-8 text-center lg:hidden">
                        <div className="text-2xl font-semibold tracking-tight" style={display}>
                            Helat
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Dari chat WhatsApp, jadi acara ter-booking.
                        </p>
                    </div>

                    <div className="mb-6">
                        <h2 className="text-2xl font-bold tracking-tight">Daftar EO baru</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Buat akun Event Organizer Anda — siap dalam semenit.
                        </p>
                    </div>

                    <SignupForm />
                </div>
            </div>
        </main>
    );
}
