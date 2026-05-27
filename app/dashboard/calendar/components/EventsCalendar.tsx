'use client';

// Polyfill the Temporal API globally. Schedule X v4 requires it and browsers
// don't ship Temporal yet (TC39 still in stage 3). Import has side effects.
import 'temporal-polyfill/global';

import { useEffect, useState, useMemo } from 'react';
import {
    ScheduleXCalendar,
    useNextCalendarApp,
} from '@schedule-x/react';
import {
    createViewMonthGrid,
    createViewWeek,
    createViewMonthAgenda,
} from '@schedule-x/calendar';
import '@schedule-x/theme-default/dist/index.css';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

// Wire shape from /api/events. Dates are ISO strings — we convert to Temporal
// instances below before handing to Schedule X.
interface ApiEvent {
    id: string;
    kind: 'event' | 'meeting';
    title: string;
    start: string;
    end: string;
    calendarId: 'events' | 'meetings';
    description?: string;
    location?: string;
}

export function EventsCalendar() {
    const [apiEvents, setApiEvents] = useState<ApiEvent[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/events', { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                setApiEvents(data.events ?? []);
            } catch (err) {
                console.error('Failed to load events', err);
                toast.error('Gagal memuat event');
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    // Convert API strings to Temporal instances. Done in a memo so the
    // mapping only runs when the source data changes, not on every render.
    const calendarEvents = useMemo(() => {
        return apiEvents
            .map((e) => {
                try {
                    const start =
                        e.kind === 'event'
                            ? Temporal.PlainDate.from(e.start)
                            : Temporal.ZonedDateTime.from(e.start);
                    const end =
                        e.kind === 'event'
                            ? Temporal.PlainDate.from(e.end)
                            : Temporal.ZonedDateTime.from(e.end);
                    return {
                        id: e.id,
                        title: e.title,
                        start,
                        end,
                        calendarId: e.calendarId,
                        description: e.description,
                        location: e.location,
                    };
                } catch (err) {
                    // A single malformed row shouldn't blow up the whole
                    // calendar — log and drop it.
                    console.error(`Skipping unparseable event ${e.id}`, err, e);
                    return null;
                }
            })
            .filter((v): v is NonNullable<typeof v> => v !== null);
    }, [apiEvents]);

    // The view instances must be stable across renders within a single mount.
    // createViewMonthGrid() generates a fresh View — call once and reuse its
    // .name for the defaultView field, rather than constructing twice.
    const monthGrid = useMemo(() => createViewMonthGrid(), []);
    const views = useMemo(
        () => [monthGrid, createViewWeek(), createViewMonthAgenda()] as const,
        [monthGrid]
    );

    const calendar = useNextCalendarApp({
        views: [...views],
        defaultView: monthGrid.name,
        events: calendarEvents,
        calendars: {
            events: {
                colorName: 'events',
                lightColors: {
                    main: '#10b981',
                    container: '#d1fae5',
                    onContainer: '#064e3b',
                },
                darkColors: {
                    main: '#34d399',
                    container: '#064e3b',
                    onContainer: '#d1fae5',
                },
            },
            meetings: {
                colorName: 'meetings',
                lightColors: {
                    main: '#8b5cf6',
                    container: '#ede9fe',
                    onContainer: '#3b0764',
                },
                darkColors: {
                    main: '#a78bfa',
                    container: '#3b0764',
                    onContainer: '#ede9fe',
                },
            },
        },
        isDark: true,
    });

    if (loading) {
        return (
            <div className="flex items-center justify-center h-96">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center gap-4 text-xs">
                <Legend color="#34d399" label="Confirmed Events" />
                <Legend color="#a78bfa" label="Online Meetings" />
                <span className="ml-auto text-muted-foreground">
                    {calendarEvents.length} jadwal
                </span>
            </div>
            <div className="h-[700px] sx-react-calendar-wrapper">
                <ScheduleXCalendar calendarApp={calendar} />
            </div>
        </div>
    );
}

function Legend({ color, label }: { color: string; label: string }) {
    return (
        <div className="flex items-center gap-2">
            <div
                className="h-3 w-3 rounded"
                style={{ backgroundColor: color }}
            />
            <span className="text-muted-foreground">{label}</span>
        </div>
    );
}
