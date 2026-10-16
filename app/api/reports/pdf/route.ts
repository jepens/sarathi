import { NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { computeReport } from '@/lib/reports/aggregate';
import { ReportDocument } from '@/lib/reports/ReportDocument';
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { getBusinessProfile } from '@/lib/settings/business-profile';

// react-pdf needs the Node runtime (not edge).
export const runtime = 'nodejs';

export async function GET(request: Request) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId } = access;

    const { searchParams } = new URL(request.url);
    const now = new Date();
    const start = searchParams.get('start') ?? new Date(now.getFullYear(), 0, 1).toISOString();
    const end = searchParams.get('end') ?? now.toISOString();

    try {
        const profile = await getBusinessProfile(supabase, orgId);
        const data = await computeReport(supabase, start, end);

        const contactLine =
            [profile.businessEmail, profile.website].filter(Boolean).join(' • ') ||
            profile.handoffName;

        // Call the component as a function — its return type is
        // ReactElement<DocumentProps>, which renderToBuffer accepts (mirrors the
        // proposal PDF pattern).
        const buffer = await renderToBuffer(
            ReportDocument({
                data,
                businessName: profile.businessName,
                contactLine,
                generatedAt: now,
            })
        );

        const stamp = now.toISOString().slice(0, 10);
        // Wrap Buffer in Uint8Array so the Web Response BodyInit type accepts it.
        return new Response(new Uint8Array(buffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="laporan-${stamp}.pdf"`,
                'Cache-Control': 'no-store, must-revalidate',
            },
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Gagal membuat PDF' },
            { status: 500 }
        );
    }
}
