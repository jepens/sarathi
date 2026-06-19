import React from 'react';
import {
    Document,
    Page,
    Text,
    View,
    StyleSheet,
    Font,
    type DocumentProps,
} from '@react-pdf/renderer';
import { type ReportData } from './types';

// Rendered server-side via renderToBuffer (see /api/reports/pdf). Lives outside
// the app router so it can be imported from an API route without client bundles.

export interface ReportDocumentProps {
    data: ReportData;
    businessName: string;
    contactLine: string;
    generatedAt: Date;
}

Font.registerHyphenationCallback((word) => [word]);

const COLORS = {
    primary: '#0f172a',
    accent: '#10b981',
    muted: '#64748b',
    border: '#e2e8f0',
    bg: '#f8fafc',
};

const styles = StyleSheet.create({
    page: { padding: 40, fontFamily: 'Helvetica', fontSize: 10, color: COLORS.primary, lineHeight: 1.5 },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 20,
        borderBottom: `2pt solid ${COLORS.accent}`,
        paddingBottom: 12,
    },
    brand: { fontSize: 18, fontFamily: 'Helvetica-Bold' },
    brandSub: { fontSize: 9, color: COLORS.muted, marginTop: 2 },
    metaBlock: { fontSize: 9, color: COLORS.muted, textAlign: 'right' },
    title: { fontSize: 16, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
    subtitle: { fontSize: 10, color: COLORS.muted, marginBottom: 16 },
    section: { marginBottom: 18 },
    sectionTitle: {
        fontSize: 11,
        fontFamily: 'Helvetica-Bold',
        color: COLORS.accent,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 8,
    },
    kpiGrid: { flexDirection: 'row', flexWrap: 'wrap' },
    kpiBox: {
        width: '33.33%',
        padding: 8,
    },
    kpiInner: {
        backgroundColor: COLORS.bg,
        border: `1pt solid ${COLORS.border}`,
        borderRadius: 4,
        padding: 10,
    },
    kpiLabel: { fontSize: 8, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
    kpiValue: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginTop: 3 },
    tableRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        borderBottom: `0.5pt solid ${COLORS.border}`,
        paddingVertical: 4,
    },
    tableLabel: { flex: 1, color: COLORS.primary },
    tableValue: { fontFamily: 'Helvetica-Bold', textAlign: 'right' },
    barTrack: { height: 6, backgroundColor: COLORS.border, borderRadius: 3, flex: 1, marginHorizontal: 8 },
    funnelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
    funnelLabel: { width: 70, color: COLORS.muted },
    funnelCount: { width: 24, textAlign: 'right', fontFamily: 'Helvetica-Bold' },
    empty: { color: COLORS.muted, fontStyle: 'italic' },
    footer: {
        position: 'absolute',
        bottom: 28,
        left: 40,
        right: 40,
        borderTop: `1pt solid ${COLORS.border}`,
        paddingTop: 10,
        fontSize: 8,
        color: COLORS.muted,
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
});

const STAGE_LABELS: Record<string, { label: string; color: string }> = {
    unstaged: { label: 'Unstaged', color: '#94a3b8' },
    new: { label: 'New', color: '#64748b' },
    qualifying: { label: 'Qualifying', color: '#3b82f6' },
    quoted: { label: 'Quoted', color: '#f59e0b' },
    scheduled: { label: 'Scheduled', color: '#8b5cf6' },
    booked: { label: 'Booked', color: '#06b6d4' },
    won: { label: 'Won', color: '#10b981' },
    lost: { label: 'Lost', color: '#f43f5e' },
};
const FUNNEL_ORDER = ['unstaged', 'new', 'qualifying', 'quoted', 'scheduled', 'booked', 'won', 'lost'];

function formatRupiah(n: number): string {
    return `Rp ${Number(n ?? 0).toLocaleString('id-ID')}`;
}
function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Jakarta',
    });
}
function formatDateTime(d: Date): string {
    return d.toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Jakarta',
    });
}

export function ReportDocument({
    data,
    businessName,
    contactLine,
    generatedAt,
}: ReportDocumentProps): React.ReactElement<DocumentProps> {
    const { kpis } = data;
    const kpiItems = [
        { label: 'Revenue', value: formatRupiah(kpis.revenue) },
        { label: 'Booking', value: String(kpis.bookings) },
        { label: 'Rata-rata nilai', value: formatRupiah(kpis.avgBookingValue) },
        { label: 'Piutang', value: formatRupiah(kpis.outstanding) },
        { label: 'Leads', value: String(kpis.leads) },
        {
            label: 'Conversion',
            value: kpis.conversionRate === null ? '—' : `${kpis.conversionRate.toFixed(0)}%`,
        },
    ];
    const funnelMax = Math.max(1, ...FUNNEL_ORDER.map((s) => data.leadFunnel[s] ?? 0));

    return (
        <Document>
            <Page size="A4" style={styles.page}>
                <View style={styles.header}>
                    <View>
                        <Text style={styles.brand}>{businessName}</Text>
                        <Text style={styles.brandSub}>Laporan Performa Event Organizer</Text>
                    </View>
                    <View style={styles.metaBlock}>
                        <Text>
                            Periode: {formatDate(data.period.start)} – {formatDate(data.period.end)}
                        </Text>
                        <Text>Dibuat: {formatDateTime(generatedAt)}</Text>
                    </View>
                </View>

                <Text style={styles.title}>Ringkasan Performa</Text>
                <Text style={styles.subtitle}>
                    Revenue, booking, piutang, dan pipeline leads untuk periode terpilih.
                </Text>

                {/* KPIs */}
                <View style={styles.kpiGrid}>
                    {kpiItems.map((k) => (
                        <View key={k.label} style={styles.kpiBox}>
                            <View style={styles.kpiInner}>
                                <Text style={styles.kpiLabel}>{k.label}</Text>
                                <Text style={styles.kpiValue}>{k.value}</Text>
                            </View>
                        </View>
                    ))}
                </View>

                {/* Revenue per bulan */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Revenue per Bulan</Text>
                    {data.revenueByMonth.length === 0 ? (
                        <Text style={styles.empty}>Belum ada data.</Text>
                    ) : (
                        data.revenueByMonth.map((r) => (
                            <View key={r.month} style={styles.tableRow}>
                                <Text style={styles.tableLabel}>{r.label}</Text>
                                <Text style={styles.tableValue}>{formatRupiah(r.revenue)}</Text>
                            </View>
                        ))
                    )}
                </View>

                {/* Revenue per jenis acara */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Revenue per Jenis Acara</Text>
                    {data.revenueByEventType.length === 0 ? (
                        <Text style={styles.empty}>Belum ada data.</Text>
                    ) : (
                        data.revenueByEventType.map((r) => (
                            <View key={r.type} style={styles.tableRow}>
                                <Text style={styles.tableLabel}>{r.type}</Text>
                                <Text style={styles.tableValue}>{formatRupiah(r.revenue)}</Text>
                            </View>
                        ))
                    )}
                </View>

                {/* Sumber lead */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Sumber Lead</Text>
                    {data.leadsBySource.length === 0 ? (
                        <Text style={styles.empty}>Belum ada data.</Text>
                    ) : (
                        data.leadsBySource.map((r) => (
                            <View key={r.label} style={styles.tableRow}>
                                <Text style={styles.tableLabel}>{r.label}</Text>
                                <Text style={styles.tableValue}>{r.count}</Text>
                            </View>
                        ))
                    )}
                </View>

                {/* Funnel */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Funnel Lead (saat ini)</Text>
                    {FUNNEL_ORDER.map((stage) => {
                        const count = data.leadFunnel[stage] ?? 0;
                        const meta = STAGE_LABELS[stage];
                        const pct = Math.round((count / funnelMax) * 100);
                        return (
                            <View key={stage} style={styles.funnelRow}>
                                <Text style={styles.funnelLabel}>{meta.label}</Text>
                                <View style={styles.barTrack}>
                                    <View
                                        style={{ height: 6, borderRadius: 3, backgroundColor: meta.color, width: `${pct}%` }}
                                    />
                                </View>
                                <Text style={styles.funnelCount}>{count}</Text>
                            </View>
                        );
                    })}
                </View>

                <View style={styles.footer} fixed>
                    <Text>{businessName}</Text>
                    <Text>{contactLine}</Text>
                </View>
            </Page>
        </Document>
    );
}
