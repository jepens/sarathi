'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, User, CalendarClock, ChevronRight, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { FollowupData, FollowupLead, FollowupBooking } from '@/lib/followup/compute';

const STAGE_LABEL: Record<string, string> = {
    new: 'New',
    qualifying: 'Qualifying',
    quoted: 'Quoted',
    scheduled: 'Scheduled',
    booked: 'Booked',
    won: 'Won',
    lost: 'Lost',
};

function leadReason(l: FollowupLead): string {
    if (l.reason === 'proposal_no_reply') return `Proposal belum dibalas ${l.days} hari`;
    return `Tidak ada aktivitas ${l.days} hari`;
}

function eventWhen(daysUntil: number): string {
    if (daysUntil <= 0) return 'hari ini';
    if (daysUntil === 1) return 'besok';
    return `H-${daysUntil}`;
}

function formatEventDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Jakarta',
    });
}

export default function FollowupPage() {
    const [data, setData] = useState<FollowupData | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/followup', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setData((await res.json()) as FollowupData);
        } catch (err) {
            console.error('Failed to load follow-up', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const leads = data?.leads ?? [];
    const bookings = data?.bookings ?? [];
    const nothing = !loading && leads.length === 0 && bookings.length === 0;

    return (
        <div className="space-y-4 sm:space-y-6">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Follow-up</h1>
                    <p className="text-muted-foreground">
                        Lead & booking yang perlu kamu tindak lanjuti sekarang.
                    </p>
                </div>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={fetchData} disabled={loading}>
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                    <span className="hidden sm:inline">Refresh</span>
                </Button>
            </div>

            {nothing && (
                <Card>
                    <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
                        <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                        <p className="font-medium text-foreground">Semua aman 🎉</p>
                        <p className="text-sm">Tidak ada lead atau booking yang perlu follow-up.</p>
                    </CardContent>
                </Card>
            )}

            {/* Leads */}
            {(loading || leads.length > 0) && (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <User className="h-4 w-4 text-muted-foreground" />
                            Lead perlu follow-up
                            {!loading && (
                                <Badge variant="secondary" className="ml-1">
                                    {data?.counts?.leads ?? leads.length}
                                </Badge>
                            )}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {loading ? (
                            Array.from({ length: 3 }).map((_, i) => (
                                <Skeleton key={i} className="h-12 w-full rounded-md" />
                            ))
                        ) : (
                            leads.map((l) => <LeadRow key={l.phone_number} lead={l} />)
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Bookings */}
            {(loading || bookings.length > 0) && (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <CalendarClock className="h-4 w-4 text-muted-foreground" />
                            Booking mendekati hari-H
                            {!loading && (
                                <Badge variant="secondary" className="ml-1">
                                    {data?.counts?.bookings ?? bookings.length}
                                </Badge>
                            )}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {loading ? (
                            Array.from({ length: 2 }).map((_, i) => (
                                <Skeleton key={i} className="h-12 w-full rounded-md" />
                            ))
                        ) : (
                            bookings.map((b) => <BookingRow key={b.id} booking={b} />)
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function LeadRow({ lead }: { lead: FollowupLead }) {
    const name = lead.contact_name || (lead.phone_number.startsWith('manual:') ? 'Tanpa nama' : lead.phone_number);
    const stage = lead.lead_stage ?? 'new';
    return (
        <Link
            href={`/dashboard/chats?phone=${encodeURIComponent(lead.phone_number)}`}
            className="flex items-center gap-3 rounded-md border bg-card p-3 transition-colors hover:bg-muted/50"
        >
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{name}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
                        {STAGE_LABEL[stage] ?? stage}
                    </Badge>
                </div>
                <p
                    className={cn(
                        'text-xs',
                        lead.reason === 'proposal_no_reply'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-muted-foreground'
                    )}
                >
                    {leadReason(lead)}
                </p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
    );
}

function BookingRow({ booking }: { booking: FollowupBooking }) {
    const soon = booking.days_until <= 2;
    return (
        <Link
            href="/dashboard/orders"
            className="flex items-center gap-3 rounded-md border bg-card p-3 transition-colors hover:bg-muted/50"
        >
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{booking.customer_name || 'Tanpa nama'}</span>
                    <Badge
                        className={cn(
                            'shrink-0 text-[10px]',
                            soon ? 'bg-rose-500' : 'bg-cyan-500'
                        )}
                    >
                        {eventWhen(booking.days_until)}
                    </Badge>
                    {!booking.dp_paid && (
                        <Badge variant="outline" className="shrink-0 border-amber-300 text-[10px] text-amber-600 dark:text-amber-400">
                            DP belum dibayar
                        </Badge>
                    )}
                    {booking.dp_paid && !booking.settled && (
                        <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                            Belum lunas
                        </Badge>
                    )}
                </div>
                <p className="text-xs text-muted-foreground">{formatEventDate(booking.event_date)}</p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
    );
}
