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

// PDF proposals are rendered server-side via renderToBuffer. This file uses
// JSX/React and lives outside the Next.js app router on purpose so it can be
// imported from API routes without pulling client bundles.

export interface ProposalLead {
    name: string;
    email: string;
    phone: string;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
}

export interface ProposalPackage {
    name: string;
    description: string | null;
    price: number;
}

export interface ProposalProps {
    lead: ProposalLead;
    packages: ProposalPackage[];
    introNote?: string | null;
    issuedAt: Date;
}

// Use the built-in Helvetica family — no external font fetch needed, keeps the
// PDF render fast and works offline. Color palette mirrors the dashboard.
Font.registerHyphenationCallback((word) => [word]);

const COLORS = {
    primary: '#0f172a',
    accent: '#10b981',
    muted: '#64748b',
    border: '#e2e8f0',
    bg: '#f8fafc',
};

const styles = StyleSheet.create({
    page: {
        padding: 48,
        fontFamily: 'Helvetica',
        fontSize: 10,
        color: COLORS.primary,
        lineHeight: 1.5,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 32,
        borderBottom: `2pt solid ${COLORS.accent}`,
        paddingBottom: 16,
    },
    brand: {
        fontSize: 18,
        fontFamily: 'Helvetica-Bold',
        color: COLORS.primary,
    },
    brandSub: {
        fontSize: 9,
        color: COLORS.muted,
        marginTop: 2,
    },
    metaBlock: {
        fontSize: 9,
        color: COLORS.muted,
        textAlign: 'right',
    },
    title: {
        fontSize: 22,
        fontFamily: 'Helvetica-Bold',
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 11,
        color: COLORS.muted,
        marginBottom: 24,
    },
    section: {
        marginBottom: 20,
    },
    sectionTitle: {
        fontSize: 11,
        fontFamily: 'Helvetica-Bold',
        color: COLORS.accent,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 8,
    },
    detailRow: {
        flexDirection: 'row',
        marginBottom: 4,
    },
    detailLabel: {
        width: 110,
        color: COLORS.muted,
    },
    detailValue: {
        flex: 1,
        fontFamily: 'Helvetica-Bold',
    },
    paragraph: {
        marginBottom: 8,
    },
    packageCard: {
        backgroundColor: COLORS.bg,
        borderLeft: `3pt solid ${COLORS.accent}`,
        padding: 12,
        marginBottom: 10,
    },
    packageName: {
        fontFamily: 'Helvetica-Bold',
        fontSize: 11,
        marginBottom: 4,
    },
    packageDescription: {
        color: COLORS.muted,
        marginBottom: 6,
    },
    packagePrice: {
        fontFamily: 'Helvetica-Bold',
        color: COLORS.accent,
    },
    footer: {
        position: 'absolute',
        bottom: 32,
        left: 48,
        right: 48,
        borderTop: `1pt solid ${COLORS.border}`,
        paddingTop: 12,
        fontSize: 9,
        color: COLORS.muted,
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    pillRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginTop: 4,
    },
    pill: {
        backgroundColor: COLORS.bg,
        border: `1pt solid ${COLORS.border}`,
        padding: '3 8',
        marginRight: 6,
        marginBottom: 4,
        fontSize: 9,
    },
});

function formatRupiah(n: number): string {
    return `Rp ${n.toLocaleString('id-ID')}`;
}

function formatDate(d: Date): string {
    return d.toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}

// Explicit return type so renderToBuffer's `ReactElement<DocumentProps>`
// parameter accepts the result. Without this annotation TS infers JSX.Element
// (ReactElement<any, any>) which is not assignable.
export function ProposalDocument({
    lead,
    packages,
    introNote,
    issuedAt,
}: ProposalProps): React.ReactElement<DocumentProps> {
    const proposalRef = `SLDR-${issuedAt.getFullYear()}${(issuedAt.getMonth() + 1)
        .toString()
        .padStart(2, '0')}${issuedAt
        .getDate()
        .toString()
        .padStart(2, '0')}-${lead.phone.slice(-4)}`;

    const eventDetails = [
        { label: 'Jenis Acara', value: lead.event_interest },
        {
            label: 'Jumlah Peserta',
            value: lead.participant_count ? `${lead.participant_count} pax` : null,
        },
        { label: 'Lokasi', value: lead.location_pref },
        { label: 'Tanggal', value: lead.event_date_pref },
        { label: 'Tujuan / Goal', value: lead.event_goals },
        { label: 'Indikasi Budget', value: lead.budget_range },
    ].filter((d) => d.value);

    return (
        <Document>
            <Page size="A4" style={styles.page}>
                <View style={styles.header}>
                    <View>
                        <Text style={styles.brand}>Sailendra Organizer</Text>
                        <Text style={styles.brandSub}>
                            Team Building • Capacity Building • Company Gathering
                        </Text>
                        <Text style={styles.brandSub}>sailendra.co.id</Text>
                    </View>
                    <View style={styles.metaBlock}>
                        <Text>Ref: {proposalRef}</Text>
                        <Text>Tanggal: {formatDate(issuedAt)}</Text>
                    </View>
                </View>

                <Text style={styles.title}>Penawaran Awal Acara</Text>
                <Text style={styles.subtitle}>
                    Untuk: {lead.name}
                    {lead.email ? ` · ${lead.email}` : ''}
                </Text>

                {introNote && (
                    <View style={styles.section}>
                        <Text style={styles.paragraph}>{introNote}</Text>
                    </View>
                )}

                {eventDetails.length > 0 && (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>Ringkasan Kebutuhan</Text>
                        {eventDetails.map((d) => (
                            <View key={d.label} style={styles.detailRow}>
                                <Text style={styles.detailLabel}>{d.label}</Text>
                                <Text style={styles.detailValue}>{d.value}</Text>
                            </View>
                        ))}
                    </View>
                )}

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Rekomendasi Paket</Text>
                    {packages.length === 0 ? (
                        <Text style={styles.paragraph}>
                            Paket detail akan dikustomisasi oleh tim kami sesuai
                            kebutuhan spesifik acara kakak. Mas MJ akan menghubungi
                            untuk diskusi konsep dan susun paket personal.
                        </Text>
                    ) : (
                        packages.map((p) => (
                            <View key={p.name} style={styles.packageCard}>
                                <Text style={styles.packageName}>{p.name}</Text>
                                {p.description && (
                                    <Text style={styles.packageDescription}>
                                        {p.description}
                                    </Text>
                                )}
                                <Text style={styles.packagePrice}>
                                    {formatRupiah(p.price)}{' '}
                                    {lead.participant_count
                                        ? `· estimasi total ${formatRupiah(
                                              p.price * lead.participant_count
                                          )} untuk ${lead.participant_count} pax`
                                        : '· per pax'}
                                </Text>
                            </View>
                        ))
                    )}
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Langkah Selanjutnya</Text>
                    <Text style={styles.paragraph}>
                        Penawaran ini bersifat indikasi awal. Untuk proposal final
                        beserta rincian rundown, vendor, dan jadwal pembayaran, tim
                        kami siap menjadwalkan online meeting 30 menit.
                    </Text>
                    <Text style={styles.paragraph}>
                        Silakan hubungi kami via WhatsApp ke nomor di footer, atau
                        balas email ini untuk konfirmasi.
                    </Text>
                </View>

                <View style={styles.footer} fixed>
                    <Text>Sailendra Organizer • info@sailendra.co.id</Text>
                    <Text>MJ (Lead Consultant) +62 812-8195-8110</Text>
                </View>
            </Page>
        </Document>
    );
}
