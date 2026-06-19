// Shared report shape — client-safe (no server imports), so the reports page,
// the aggregation helper, and the PDF document can all use it.
export interface ReportData {
    period: { start: string; end: string };
    kpis: {
        revenue: number;
        bookings: number;
        avgBookingValue: number;
        outstanding: number;
        leads: number;
        conversionRate: number | null;
    };
    revenueByMonth: { month: string; label: string; revenue: number }[];
    revenueByEventType: { type: string; revenue: number }[];
    leadsBySource: { label: string; count: number }[];
    leadFunnel: Record<string, number>;
}
