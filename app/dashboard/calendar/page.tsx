import { EventsCalendar } from './components/EventsCalendar';

export default function CalendarPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Calendar</h1>
                <p className="text-muted-foreground">
                    Lihat jadwal event dan online meeting Anda.
                </p>
            </div>
            <EventsCalendar />
        </div>
    );
}
