import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { leadInputSchema } from '@/lib/leads/schema';
import { createOrFillLead } from '@/lib/leads/create';

// Bulk lead import (the CSV import flow). The client maps spreadsheet columns to
// field keys and POSTs `{ rows: [{ contact_name, phone_number, ... }, ...] }`;
// each row is validated and upserted with the same fill-empty dedup as the
// single-create endpoint. Rows are processed SEQUENTIALLY on purpose: two rows
// sharing a phone number must fill-empty the same row, not race into a unique
// violation.

const MAX_ROWS = 2000;

type RowError = { index: number; message: string };

function isBlankRow(row: Record<string, unknown>): boolean {
    return Object.values(row).every(
        (v) => v == null || (typeof v === 'string' && v.trim() === '')
    );
}

export async function POST(request: Request) {
    const supabase = await createClient();

    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) {
        return NextResponse.json(
            { error: 'Tidak ada organisasi aktif untuk akun ini' },
            { status: 403 }
        );
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rows = (body as { rows?: unknown })?.rows;
    if (!Array.isArray(rows)) {
        return NextResponse.json(
            { error: 'Body harus berupa { rows: [...] }' },
            { status: 400 }
        );
    }
    if (rows.length === 0) {
        return NextResponse.json({ error: 'Tidak ada baris untuk diimpor' }, { status: 400 });
    }
    if (rows.length > MAX_ROWS) {
        return NextResponse.json(
            { error: `Maksimal ${MAX_ROWS} baris per impor (diterima ${rows.length})` },
            { status: 400 }
        );
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0; // blank rows
    let conflicts = 0; // phone belongs to a vendor/other contact
    const errors: RowError[] = [];

    for (let i = 0; i < rows.length; i++) {
        const raw = rows[i];
        if (raw == null || typeof raw !== 'object') {
            errors.push({ index: i, message: 'Baris tidak valid' });
            continue;
        }
        if (isBlankRow(raw as Record<string, unknown>)) {
            skipped++;
            continue;
        }

        const parsed = leadInputSchema.safeParse(raw);
        if (!parsed.success) {
            errors.push({
                index: i,
                message: parsed.error.issues
                    .map((issue) => issue.message)
                    .join('; '),
            });
            continue;
        }

        try {
            const result = await createOrFillLead(supabase, orgId, parsed.data);
            if (result.result === 'created') created++;
            else if (result.result === 'updated') updated++;
            else if (result.result === 'unchanged') unchanged++;
            else if (result.result === 'skipped_non_lead') {
                conflicts++;
                errors.push({
                    index: i,
                    message: 'Nomor sudah terdaftar sebagai kontak lain (vendor/lainnya), dilewati',
                });
            }
        } catch (err) {
            errors.push({
                index: i,
                message: err instanceof Error ? err.message : 'Gagal menyimpan',
            });
        }
    }

    return NextResponse.json({
        total: rows.length,
        created,
        updated,
        unchanged,
        skipped,
        conflicts,
        errorCount: errors.length,
        errors,
    });
}
