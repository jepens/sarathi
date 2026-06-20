"use client";

import Link from "next/link";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  CalendarClock,
  Kanban,
  MessageSquare,
  Radio,
} from "lucide-react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { SarathiMark } from "@/components/sarathi-mark";

// Display = Space Grotesk: a technical grotesque that reads like control-room
// signage, carrying a live-ops personality without the costume of an all-caps
// condensed playbill face. Pushed to a clamp() marquee scale for spectacle,
// kept sentence case so the Indonesian copy stays human.
// Mono = JetBrains Mono: built for digit clarity, so the pipeline counts and
// stage labels stay grid-aligned like a real ops board.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

// The signature element mirrors the REAL product: the sales pipeline at
// /dashboard/pipeline. Stage names and colors match the dashboard's
// STAGE_LABELS exactly, so the landing illustrates a capability this app
// actually has (not a rundown — that lives in a different product).
type Stage = {
  key: string;
  label: string;
  count: number;
  color: string;
};

const pipeline: Stage[] = [
  { key: "new", label: "Baru", count: 4, color: "#94A3B8" }, // slate
  { key: "qualifying", label: "Qualifying", count: 3, color: "#60A5FA" }, // blue
  { key: "quoted", label: "Quoted", count: 5, color: "#FBBF24" }, // amber
  { key: "booked", label: "Booked", count: 2, color: "#22D3EE" }, // cyan
  { key: "won", label: "Won", count: 6, color: "#34D399" }, // emerald
];

// The row we spotlight: a fresh WhatsApp lead landing on Booked — the moment
// an inquiry becomes a real deal.
const ACTIVE_STAGE = 3; // Booked

// Orchestrated-load timing derived from constants so the incoming-deal card
// slides in only after the stage rows have settled — no magic numbers, and it
// stays in sync if the stage list changes.
const ROW_BASE_DELAY = 0.25;
const ROW_STAGGER = 0.07;
const ROW_DURATION = 0.4;
const DEAL_DELAY =
  ROW_BASE_DELAY + (pipeline.length - 1) * ROW_STAGGER + ROW_DURATION * 0.8;

const features = [
  {
    icon: MessageSquare,
    title: "Balas klien di WhatsApp",
    body: "Asisten menjawab calon klien dengan cepat dan sesuai gaya Sailendra, jadi tidak ada chat yang menggantung saat kamu lagi di lapangan.",
  },
  {
    icon: Kanban,
    title: "Pipeline dari inquiry sampai deal",
    body: "Setiap lead jalan rapi dari tanya-tanya, nego, quote, sampai booking. Kamu tahu posisi tiap deal tanpa harus buka banyak catatan.",
  },
  {
    icon: CalendarClock,
    title: "Kalender & booking anti-bentrok",
    body: "Semua acara tampil di satu kalender dan tanggalnya terkunci begitu deal jadi. Asisten langsung mengingatkan kalau ada jadwal yang tabrakan.",
  },
] as const;

export default function Home() {
  const reduce = useReducedMotion();
  const maxCount = Math.max(...pipeline.map((s) => s.count));

  // Orchestrated load: stage rows slide in and their bars fill in sequence,
  // then the incoming WhatsApp deal drops onto the Booked row. Reduced motion
  // renders the final resting state immediately with no animation.
  const railContainer: Variants = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: reduce ? 0 : ROW_STAGGER,
        delayChildren: 0.2,
      },
    },
  };

  const rowVariant: Variants = {
    hidden: reduce ? { opacity: 1, x: 0 } : { opacity: 0, x: 14 },
    show: {
      opacity: 1,
      x: 0,
      transition: { duration: ROW_DURATION, ease: [0.16, 1, 0.3, 1] },
    },
  };

  const copyContainer: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : 0.08 } },
  };

  const copyItem: Variants = {
    hidden: reduce ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
    },
  };

  return (
    <div
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} flex min-h-screen flex-col bg-brand-ink text-brand-bone selection:bg-brand-gold/25 selection:text-brand-bone`}
    >
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-brand-brass/25 bg-brand-ink/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-screen-xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-ink"
          >
            <span className="grid h-9 w-9 place-items-center rounded-md border border-brand-brass/40 bg-brand-surface">
              <SarathiMark className="h-[22px] w-[22px]" />
            </span>
            <span className="font-display text-lg font-semibold tracking-tight text-brand-bone">
              Sarathi
            </span>
          </Link>
          <nav className="flex items-center gap-1.5 sm:gap-3">
            <Link href="/login">
              <Button
                variant="ghost"
                size="sm"
                className="text-brand-muted hover:bg-brand-surface hover:text-brand-bone focus-visible:ring-brand-gold/70"
              >
                Masuk
              </Button>
            </Link>
            <Link href="/login">
              <Button
                size="sm"
                className="bg-brand-gold font-semibold text-brand-ink hover:bg-brand-gold/90 focus-visible:ring-brand-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-ink"
              >
                Mulai
              </Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero — split: copy left, live pipeline rail right */}
        <section className="relative overflow-hidden">
          {/* quiet brass grid wash — no WebGL fluid, no blur blobs */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.035]"
            style={{
              backgroundImage:
                "linear-gradient(var(--brand-brass) 1px, transparent 1px), linear-gradient(90deg, var(--brand-brass) 1px, transparent 1px)",
              backgroundSize: "46px 46px",
            }}
          />
          {/* Nila wash — a faint indigo glow for the "night-journey" depth; the
              brand's second colour (Kanaka & Nila) introduced quietly so the
              gold stays the lead and the indigo only sets the mood. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 -right-24 h-[55vh] w-[55vh] rounded-full opacity-[0.12] blur-3xl"
            style={{
              background:
                "radial-gradient(circle, var(--brand-indigo) 0%, transparent 70%)",
            }}
          />
          <div className="relative mx-auto grid max-w-screen-xl items-center gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-28">
            {/* Copy */}
            <motion.div
              variants={copyContainer}
              initial="hidden"
              animate="show"
              className="flex flex-col items-start"
            >
              <motion.div
                variants={copyItem}
                className="inline-flex items-center gap-2 rounded-full border border-brand-brass/40 bg-brand-surface px-3.5 py-1.5 text-xs font-medium text-brand-gold"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span>Tersambung ke WhatsApp klien</span>
              </motion.div>

              <motion.h1
                variants={copyItem}
                className="font-display mt-6 text-[clamp(2.5rem,6.4vw,4.75rem)] font-bold leading-[1.02] tracking-tight text-brand-bone"
              >
                Dari chat WhatsApp,{" "}
                <span className="text-brand-gold">jadi acara ter-booking.</span>
              </motion.h1>

              <motion.p
                variants={copyItem}
                className="mt-6 max-w-xl text-base leading-relaxed text-brand-muted sm:text-lg"
              >
                Asisten AI yang membalas calon klien di WhatsApp, menggerakkan
                tiap lead lewat pipeline dari inquiry sampai deal, dan menjaga
                semua jadwal acara tetap rapi.
              </motion.p>

              <motion.div
                variants={copyItem}
                className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
              >
                <Link href="/login" className="w-full sm:w-auto">
                  <Button
                    size="lg"
                    className="h-12 w-full bg-brand-gold px-7 text-base font-semibold text-brand-ink hover:bg-brand-gold/90 focus-visible:ring-brand-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-ink sm:w-auto"
                  >
                    Mulai gratis <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <Link href="#features" className="w-full sm:w-auto">
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-12 w-full border-brand-brass/40 bg-transparent px-7 text-base text-brand-bone hover:bg-brand-surface hover:text-brand-bone focus-visible:ring-brand-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-ink sm:w-auto"
                  >
                    Lihat fitur
                  </Button>
                </Link>
              </motion.div>
            </motion.div>

            {/* SIGNATURE: live sales pipeline */}
            <div className="relative">
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="relative overflow-hidden rounded-xl border border-brand-brass/30 bg-brand-surface shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]"
              >
                {/* Rail header */}
                <div className="flex items-center justify-between border-b border-brand-brass/20 px-5 py-3.5">
                  <span className="font-rail text-[11px] uppercase tracking-[0.22em] text-brand-muted">
                    Pipeline
                    <span className="ml-2 normal-case tracking-normal text-brand-muted/70">
                      / Lead
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-2 font-rail text-[11px] uppercase tracking-[0.18em] text-[#34D399]">
                    <Radio
                      className={reduce ? "h-3.5 w-3.5" : "cue-live h-3.5 w-3.5"}
                    />
                    Live
                  </span>
                </div>

                {/* Stage rows */}
                <motion.ul
                  variants={railContainer}
                  initial="hidden"
                  animate="show"
                  className="relative"
                >
                  {pipeline.map((stage, i) => {
                    const isActive = i === ACTIVE_STAGE;
                    const pct = maxCount > 0 ? (stage.count / maxCount) * 100 : 0;
                    return (
                      <motion.li
                        key={stage.key}
                        variants={rowVariant}
                        className={`relative flex items-center gap-4 border-b border-brand-brass/10 px-5 py-3 last:border-b-0 ${isActive ? "bg-brand-gold/[0.06]" : ""
                          }`}
                      >
                        {/* gold marker on the live stage */}
                        {isActive && (
                          <span
                            aria-hidden
                            className="absolute inset-y-0 left-0 w-0.5 bg-brand-gold"
                          />
                        )}
                        {/* stage dot — pulses on the live stage */}
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${isActive && !reduce ? "cue-live" : ""
                            }`}
                          style={{
                            backgroundColor: stage.color,
                            boxShadow: `0 0 10px ${stage.color}66`,
                          }}
                        />
                        <span className="font-rail w-24 shrink-0 text-sm uppercase tracking-[0.06em] text-brand-bone">
                          {stage.label}
                        </span>
                        {/* count bar — echoes the dashboard Lead Funnel */}
                        <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-brand-ink">
                          <motion.span
                            aria-hidden
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: stage.color,
                              transformOrigin: "left",
                            }}
                            initial={{ scaleX: reduce ? 1 : 0 }}
                            animate={{ scaleX: 1 }}
                            transition={
                              reduce
                                ? { duration: 0 }
                                : {
                                  duration: 0.5,
                                  delay: ROW_BASE_DELAY + i * ROW_STAGGER,
                                  ease: [0.16, 1, 0.3, 1],
                                }
                            }
                          />
                        </span>
                        <span
                          className="font-rail w-6 shrink-0 text-right text-sm font-medium"
                          style={{ color: stage.color }}
                        >
                          {stage.count}
                        </span>
                      </motion.li>
                    );
                  })}
                </motion.ul>

                {/* Incoming WhatsApp lead landing on the pipeline */}
                <motion.div
                  className="flex items-center gap-3 border-t border-brand-brass/20 px-5 py-3.5"
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { duration: 0.5, delay: DEAL_DELAY, ease: [0.16, 1, 0.3, 1] }
                  }
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[#34D399]/15">
                    <MessageSquare className="h-3.5 w-3.5 text-[#34D399]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-rail text-[10px] uppercase tracking-[0.16em] text-brand-muted">
                      Lead baru dari WhatsApp
                    </p>
                    <p className="truncate text-sm text-brand-bone">
                      Budi · Employee Gathering 300 pax
                    </p>
                  </div>
                  <span className="font-rail shrink-0 text-[10px] uppercase tracking-[0.18em] text-[#22D3EE]">
                    → Booked
                  </span>
                </motion.div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section
          id="features"
          className="scroll-mt-20 border-t border-brand-brass/20 py-16 md:py-24"
        >
          <div className="mx-auto max-w-screen-xl px-4 sm:px-6">
            <div className="max-w-2xl">
              <span className="font-rail text-[11px] uppercase tracking-[0.22em] text-brand-gold">
                Cara kerjanya
              </span>
              <h2 className="font-display mt-3 text-3xl font-bold leading-tight tracking-tight text-brand-bone sm:text-4xl md:text-5xl">
                Satu alur, dari chat sampai booking.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-brand-muted sm:text-lg">
                Tiga hal yang paling sering bikin lead lolos, sekarang ditangani
                satu asisten.
              </p>
            </div>

            <div className="mt-12 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              {features.map((f, i) => {
                const Icon = f.icon;
                return (
                  <motion.div
                    key={f.title}
                    initial={
                      reduce ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }
                    }
                    whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-60px" }}
                    transition={
                      reduce
                        ? { duration: 0 }
                        : {
                          duration: 0.5,
                          delay: i * 0.08,
                          ease: [0.16, 1, 0.3, 1],
                        }
                    }
                    className="group flex flex-col rounded-xl border border-brand-brass/25 bg-brand-surface p-6 transition-colors duration-300 hover:border-brand-gold/50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="grid h-11 w-11 place-items-center rounded-lg border border-brand-brass/40 bg-brand-ink text-brand-gold transition-colors duration-300 group-hover:border-brand-gold/60">
                        <Icon className="h-5 w-5" />
                      </span>
                      <span className="font-rail text-xs uppercase tracking-[0.2em] text-brand-muted">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <h3 className="font-display mt-5 text-xl font-semibold tracking-tight text-brand-bone">
                      {f.title}
                    </h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-brand-muted">
                      {f.body}
                    </p>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-brand-brass/20 py-8">
        <div className="mx-auto flex max-w-screen-xl flex-col items-center justify-between gap-4 px-4 sm:px-6 md:h-16 md:flex-row">
          <p className="text-center text-sm text-brand-muted md:text-left">
            Sarathi — dibuat oleh{" "}
            <a
              href="https://sailendra.co.id/"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm font-medium text-brand-bone underline decoration-brand-brass/50 underline-offset-4 outline-none transition-colors hover:text-brand-gold focus-visible:ring-2 focus-visible:ring-brand-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-ink"
            >
              Sailendra Organizer
            </a>
            .
          </p>
          <div className="flex gap-5 text-sm text-brand-muted">
            <Link
              href="#"
              className="rounded-sm outline-none transition-colors hover:text-brand-bone focus-visible:ring-2 focus-visible:ring-brand-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-ink"
            >
              Kebijakan Privasi
            </Link>
            <Link
              href="#"
              className="rounded-sm outline-none transition-colors hover:text-brand-bone focus-visible:ring-2 focus-visible:ring-brand-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-ink"
            >
              Ketentuan Layanan
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
