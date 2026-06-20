'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
    Users,
    TrendingUp,
    Calendar as CalendarIcon,
    Wallet,
    Activity,
    ArrowRight,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OnboardingChecklist } from './OnboardingChecklist';
import { Skeleton } from '@/components/ui/skeleton';

const STAGE_LABELS: Record<string, { label: string; color: string }> = {
    unstaged: { label: 'Unstaged', color: 'bg-slate-500/15 text-slate-400' },
    new: { label: 'New', color: 'bg-slate-500/15 text-slate-400' },
    qualifying: { label: 'Qualifying', color: 'bg-blue-500/15 text-blue-400' },
    quoted: { label: 'Quoted', color: 'bg-amber-500/15 text-amber-400' },
    scheduled: { label: 'Scheduled', color: 'bg-purple-500/15 text-purple-400' },
    booked: { label: 'Booked', color: 'bg-cyan-500/15 text-cyan-400' },
    won: { label: 'Won', color: 'bg-emerald-500/15 text-emerald-400' },
    lost: { label: 'Lost', color: 'bg-rose-500/15 text-rose-400' },
};

const STAGE_ORDER = [
    'unstaged',
    'new',
    'qualifying',
    'quoted',
    'scheduled',
    'booked',
    'won',
    'lost',
] as const;

interface UpcomingEvent {
    id: string;
    customer_name: string | null;
    event_date: string | null;
    headcount: number | null;
    total_amount: number | null;
    status: string | null;
}

interface DashboardStats {
    leadFunnel: Record<string, number>;
    leadsThisMonth: number;
    conversionRate: number | null;
    upcomingEvents: UpcomingEvent[];
    revenueThisMonth: number;
    revenueYTD: number;
    totalLeads: number;
}

function formatRupiah(n: number): string {
    return `Rp ${n.toLocaleString('id-ID')}`;
}

function formatEventDate(iso: string | null): string {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
}

export default function DashboardPage() {
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/dashboard/stats', { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as DashboardStats;
                setStats(data);
            } catch (err) {
                console.error('Failed to load stats', err);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    return (
        <div className="space-y-3 sm:space-y-5 lg:space-y-6">
            <div>
                <h2 className="text-lg font-bold tracking-tight sm:text-2xl lg:text-3xl">Dashboard Overview</h2>
                <p className="text-muted-foreground">
                    Selamat datang di Sarathi — AI untuk Event Organizer
                </p>
            </div>

            {/* Onboarding checklist — auto-hides once the org has started operating */}
            <OnboardingChecklist />

            {/* Top stats */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
                <KpiCard
                    title="Total Leads"
                    icon={<Users className="h-4 w-4 text-muted-foreground" />}
                    primary={loading ? <Skeleton className="h-7 w-24" /> : (stats?.totalLeads ?? 0).toString()}
                    secondary={
                        loading ? (
                            <Skeleton className="mt-1 h-3 w-28" />
                        ) : (
                            `${stats?.leadsThisMonth ?? 0} baru bulan ini`
                        )
                    }
                />
                <KpiCard
                    title="Conversion Rate"
                    icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
                    primary={
                        loading ? (
                            <Skeleton className="h-7 w-24" />
                        ) : stats?.conversionRate === null ? (
                            '—'
                        ) : (
                            `${stats!.conversionRate!.toFixed(0)}%`
                        )
                    }
                    secondary={
                        loading ? (
                            <Skeleton className="mt-1 h-3 w-28" />
                        ) : (
                            `${stats?.leadFunnel.won ?? 0} won / ${stats?.leadFunnel.lost ?? 0} lost`
                        )
                    }
                />
                <KpiCard
                    title="Revenue Bulan Ini"
                    icon={<Wallet className="h-4 w-4 text-muted-foreground" />}
                    primary={loading ? <Skeleton className="h-7 w-28" /> : formatRupiah(stats?.revenueThisMonth ?? 0)}
                    secondary={
                        loading ? (
                            <Skeleton className="mt-1 h-3 w-24" />
                        ) : (
                            `YTD: ${formatRupiah(stats?.revenueYTD ?? 0)}`
                        )
                    }
                />
                <KpiCard
                    title="System"
                    icon={<Activity className="h-4 w-4 text-muted-foreground" />}
                    primary={
                        <Badge variant="default" className="bg-green-500/15 text-green-500 hover:bg-green-500/25 border-green-500/20">
                            Online
                        </Badge>
                    }
                    secondary="Semua sistem normal"
                />
            </div>

            {/* Funnel + upcoming */}
            <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle>Lead Funnel</CardTitle>
                            <CardDescription>Distribusi lead per stage</CardDescription>
                        </div>
                        <Link
                            href="/dashboard/pipeline"
                            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                        >
                            Open Pipeline <ArrowRight className="h-3 w-3" />
                        </Link>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? (
                            <div className="space-y-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="space-y-1">
                                        <div className="flex items-center justify-between">
                                            <Skeleton className="h-5 w-20 rounded" />
                                            <Skeleton className="h-4 w-6 rounded" />
                                        </div>
                                        <Skeleton className="h-1.5 w-full rounded" />
                                    </div>
                                ))}
                            </div>
                        ) : (
                            STAGE_ORDER.map((stage) => {
                                const count = stats?.leadFunnel[stage] ?? 0;
                                const total = stats?.totalLeads ?? 0;
                                const pct = total > 0 ? (count / total) * 100 : 0;
                                const meta = STAGE_LABELS[stage];
                                return (
                                    <div key={stage} className="space-y-1">
                                        <div className="flex items-center justify-between text-sm">
                                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${meta.color}`}>
                                                {meta.label}
                                            </span>
                                            <span className="text-muted-foreground">
                                                {count}
                                            </span>
                                        </div>
                                        <div className="h-1.5 bg-muted rounded overflow-hidden">
                                            <div
                                                className="h-full bg-primary transition-all"
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle>Upcoming Events</CardTitle>
                            <CardDescription>10 event terdekat</CardDescription>
                        </div>
                        <Link
                            href="/dashboard/calendar"
                            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                        >
                            Open Calendar <ArrowRight className="h-3 w-3" />
                        </Link>
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <ul className="divide-y">
                                {Array.from({ length: 5 }).map((_, i) => (
                                    <li key={i} className="flex items-center justify-between py-2">
                                        <div className="space-y-1.5">
                                            <Skeleton className="h-4 w-32" />
                                            <Skeleton className="h-3 w-24" />
                                        </div>
                                        <Skeleton className="h-4 w-16" />
                                    </li>
                                ))}
                            </ul>
                        ) : (stats?.upcomingEvents.length ?? 0) === 0 ? (
                            <div className="text-sm text-muted-foreground text-center py-8">
                                <CalendarIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
                                Belum ada event terjadwal.
                            </div>
                        ) : (
                            <ul className="divide-y">
                                {stats!.upcomingEvents.map((e) => (
                                    <li
                                        key={e.id}
                                        className="py-2 flex items-center justify-between text-sm"
                                    >
                                        <div className="min-w-0">
                                            <p className="font-medium truncate">
                                                {e.customer_name ?? 'Klien'}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatEventDate(e.event_date)}
                                                {e.headcount ? ` · ${e.headcount} pax` : ''}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-xs font-medium">
                                                {formatRupiah(Number(e.total_amount ?? 0))}
                                            </p>
                                            {e.status && (
                                                <p className="text-xs text-muted-foreground capitalize">
                                                    {e.status}
                                                </p>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

function KpiCard({
    title,
    icon,
    primary,
    secondary,
}: {
    title: string;
    icon: React.ReactNode;
    primary: React.ReactNode;
    secondary: React.ReactNode;
}) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{title}</CardTitle>
                {icon}
            </CardHeader>
            <CardContent>
                <div className="text-base font-bold sm:text-xl lg:text-2xl">{primary}</div>
                <div className="text-xs text-muted-foreground">{secondary}</div>
            </CardContent>
        </Card>
    );
}
