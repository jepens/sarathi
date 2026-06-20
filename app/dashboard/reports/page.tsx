'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ResponsiveContainer,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    Cell,
} from 'recharts';
import { FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatRupiah } from '@/lib/bookings/schema';
import { type ReportData } from '@/lib/reports/types';

const STAGE_META: Record<string, { label: string; color: string }> = {
    unstaged: { label: 'Unstaged', color: 'bg-slate-400' },
    new: { label: 'New', color: 'bg-slate-500' },
    qualifying: { label: 'Qualifying', color: 'bg-blue-500' },
    quoted: { label: 'Quoted', color: 'bg-amber-500' },
    scheduled: { label: 'Scheduled', color: 'bg-purple-500' },
    booked: { label: 'Booked', color: 'bg-cyan-500' },
    won: { label: 'Won', color: 'bg-emerald-500' },
    lost: { label: 'Lost', color: 'bg-rose-500' },
};
const FUNNEL_ORDER = ['unstaged', 'new', 'qualifying', 'quoted', 'scheduled', 'booked', 'won', 'lost'];
// Categorical series — lead with the brand (gold = Kanaka, indigo = Nila) then
// functional accents. Literal hex because recharts sets SVG `fill` attributes,
// which don't resolve CSS custom properties; these mirror the --brand-* tokens.
const CHART_COLORS = ['#e6b450', '#818cf8', '#34d399', '#22d3ee', '#fbbf24', '#f472b6', '#f87171', '#94a3b8'];

const TOOLTIP_STYLE = {
    backgroundColor: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: '0.5rem',
    color: 'var(--popover-foreground)',
    fontSize: '12px',
};

function compactRupiah(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} M`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
    if (n >= 1_000) return `${Math.round(n / 1_000)} rb`;
    return String(n);
}

type Preset = 'month' | '3m' | 'ytd' | 'custom';

function rangeFor(preset: Preset, customStart: string, customEnd: string): { start: string; end: string } {
    const now = new Date();
    const end = now.toISOString();
    if (preset === 'month') return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), end };
    if (preset === '3m') return { start: new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString(), end };
    if (preset === 'ytd') return { start: new Date(now.getFullYear(), 0, 1).toISOString(), end };
    // Guard against invalid / out-of-range typed dates (toISOString would throw
    // a RangeError during render otherwise).
    const sd = new Date(`${customStart}T00:00:00`);
    const ed = new Date(`${customEnd}T23:59:59`);
    const s =
        customStart && !Number.isNaN(sd.getTime())
            ? sd.toISOString()
            : new Date(now.getFullYear(), 0, 1).toISOString();
    const e = customEnd && !Number.isNaN(ed.getTime()) ? ed.toISOString() : end;
    return { start: s, end: e };
}

const PRESETS: { value: Preset; label: string }[] = [
    { value: 'month', label: 'Bulan ini' },
    { value: '3m', label: '3 Bulan' },
    { value: 'ytd', label: 'Tahun ini' },
    { value: 'custom', label: 'Custom' },
];

export default function ReportsPage() {
    const [preset, setPreset] = useState<Preset>('ytd');
    const [customStart, setCustomStart] = useState('');
    const [customEnd, setCustomEnd] = useState('');
    const [data, setData] = useState<ReportData | null>(null);
    const [loading, setLoading] = useState(true);

    const { start, end } = useMemo(
        () => rangeFor(preset, customStart, customEnd),
        [preset, customStart, customEnd]
    );
    const maxDate = new Date().toISOString().slice(0, 10);

    const fetchReport = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/reports?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, {
                cache: 'no-store',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setData((await res.json()) as ReportData);
        } catch (err) {
            console.error('Failed to load report', err);
        } finally {
            setLoading(false);
        }
    }, [start, end]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const funnelMax = data
        ? Math.max(1, ...FUNNEL_ORDER.map((s) => data.leadFunnel[s] ?? 0))
        : 1;

    return (
        <div className="space-y-4 sm:space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Laporan</h1>
                    <p className="text-muted-foreground">Ringkasan performa & insight Event Organizer.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {PRESETS.map((p) => (
                        <Button
                            key={p.value}
                            variant={preset === p.value ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setPreset(p.value)}
                        >
                            {p.label}
                        </Button>
                    ))}
                    <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() =>
                            window.open(
                                `/api/reports/pdf?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
                                '_blank'
                            )
                        }
                    >
                        <FileText className="h-4 w-4" /> PDF
                    </Button>
                </div>
            </div>

            {preset === 'custom' && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Dari</span>
                    <Input
                        type="date"
                        value={customStart}
                        max={maxDate}
                        onChange={(e) => setCustomStart(e.target.value)}
                        className="w-auto"
                    />
                    <span className="text-muted-foreground">sampai</span>
                    <Input
                        type="date"
                        value={customEnd}
                        max={maxDate}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        className="w-auto"
                    />
                </div>
            )}

            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
                <KpiCard title="Revenue" loading={loading} value={data ? formatRupiah(data.kpis.revenue) : '—'} hint="paid / won / completed" />
                <KpiCard title="Booking" loading={loading} value={data ? String(data.kpis.bookings) : '—'} hint="dibuat di periode ini" />
                <KpiCard title="Rata-rata nilai" loading={loading} value={data ? formatRupiah(data.kpis.avgBookingValue) : '—'} hint="per booking" />
                <KpiCard title="Piutang" loading={loading} value={data ? formatRupiah(data.kpis.outstanding) : '—'} hint="sisa belum lunas (saat ini)" />
                <KpiCard title="Leads" loading={loading} value={data ? String(data.kpis.leads) : '—'} hint="masuk di periode ini" />
                <KpiCard
                    title="Conversion"
                    loading={loading}
                    value={data ? (data.kpis.conversionRate === null ? '—' : `${data.kpis.conversionRate.toFixed(0)}%`) : '—'}
                    hint="won / (won + lost)"
                />
            </div>

            {/* Revenue trend */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Revenue per bulan</CardTitle>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <Skeleton className="h-[260px] w-full" />
                    ) : (data?.revenueByMonth.length ?? 0) === 0 ? (
                        <Empty />
                    ) : (
                        <div className="h-[260px] w-full text-muted-foreground">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={data!.revenueByMonth} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
                                    <XAxis dataKey="label" tick={{ fill: 'currentColor', fontSize: 11 }} tickLine={false} axisLine={false} />
                                    <YAxis tickFormatter={compactRupiah} tick={{ fill: 'currentColor', fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
                                    <Tooltip
                                        cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                                        contentStyle={TOOLTIP_STYLE}
                                        formatter={(v) => [formatRupiah(Number(v)), 'Revenue']}
                                    />
                                    <Bar dataKey="revenue" fill="#e6b450" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
                {/* Revenue by event type */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Revenue per jenis acara</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Skeleton className="h-[260px] w-full" />
                        ) : (data?.revenueByEventType.length ?? 0) === 0 ? (
                            <Empty />
                        ) : (
                            <div className="h-[260px] w-full text-muted-foreground">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart
                                        data={data!.revenueByEventType}
                                        layout="vertical"
                                        margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} horizontal={false} />
                                        <XAxis type="number" tickFormatter={compactRupiah} tick={{ fill: 'currentColor', fontSize: 11 }} tickLine={false} axisLine={false} />
                                        <YAxis type="category" dataKey="type" width={110} tick={{ fill: 'currentColor', fontSize: 11 }} tickLine={false} axisLine={false} />
                                        <Tooltip
                                            cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                                            contentStyle={TOOLTIP_STYLE}
                                            formatter={(v) => [formatRupiah(Number(v)), 'Revenue']}
                                        />
                                        <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                                            {data!.revenueByEventType.map((_, i) => (
                                                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Leads by source */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Sumber lead</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Skeleton className="h-[260px] w-full" />
                        ) : (data?.leadsBySource.length ?? 0) === 0 ? (
                            <Empty />
                        ) : (
                            <div className="h-[260px] w-full text-muted-foreground">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart
                                        data={data!.leadsBySource}
                                        layout="vertical"
                                        margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} horizontal={false} />
                                        <XAxis type="number" allowDecimals={false} tick={{ fill: 'currentColor', fontSize: 11 }} tickLine={false} axisLine={false} />
                                        <YAxis type="category" dataKey="label" width={90} tick={{ fill: 'currentColor', fontSize: 11 }} tickLine={false} axisLine={false} />
                                        <Tooltip
                                            cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                                            contentStyle={TOOLTIP_STYLE}
                                            formatter={(v) => [Number(v), 'Leads']}
                                        />
                                        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                                            {data!.leadsBySource.map((_, i) => (
                                                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* Lead funnel */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Funnel lead (saat ini)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {loading ? (
                        <Skeleton className="h-40 w-full" />
                    ) : (
                        FUNNEL_ORDER.map((stage) => {
                            const count = data?.leadFunnel[stage] ?? 0;
                            const meta = STAGE_META[stage];
                            const pct = (count / funnelMax) * 100;
                            return (
                                <div key={stage} className="flex items-center gap-3 text-sm">
                                    <span className="w-20 shrink-0 text-muted-foreground">{meta.label}</span>
                                    <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                                        <div className={cn('h-full rounded', meta.color)} style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="w-8 shrink-0 text-right font-medium">{count}</span>
                                </div>
                            );
                        })
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

function KpiCard({ title, value, hint, loading }: { title: string; value: string; hint: string; loading: boolean }) {
    return (
        <Card>
            <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <Skeleton className="h-6 w-24" />
                ) : (
                    <div className="text-base font-bold sm:text-xl">{value}</div>
                )}
                <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
            </CardContent>
        </Card>
    );
}

function Empty() {
    return (
        <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            Belum ada data untuk periode ini.
        </div>
    );
}
