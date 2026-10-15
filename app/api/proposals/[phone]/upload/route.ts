import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { generateProposalRef } from '@/lib/proposals/ref';
import { requireOrgMember } from '@/lib/settings/org-context';
import { proposalObjectKey } from '@/lib/storage/object-paths';

// POST /api/proposals/[phone]/upload
// Accepts a multipart form with a single `file` field (PDF).
// On success, the file is stored at `proposals/{org_id}/{phone}/{uuid}.pdf` in
// Supabase Storage and a row is inserted into the `proposals` table with
// source='uploaded', sent_at=null. The returned `proposal_id` is what the
// dialog uses for the subsequent preview / send.
//
// Route Handlers don't impose Server Action's body size limit; we still
// enforce 10 MB at the Storage layer (allowed_mime_types + file_size_limit)
// and double-check here so we fail fast before streaming.

export const runtime = 'nodejs';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set(['application/pdf']);

// Defensive: phone is route-param-derived but `phone` is used to build a
// Storage path. Reject anything that isn't a plausible WhatsApp number to
// prevent path traversal or odd chars from confusing Storage.
const PHONE_REGEX = /^[0-9]{8,15}$/;

export async function POST(
    request: Request,
    { params }: { params: Promise<{ phone: string }> }
) {
    const supabase = await createClient();

    // Membership gate: the object key + the proposals row are both stamped with
    // the caller's org (storage RLS authorises by the "<org_id>/" prefix).
    const access = await requireOrgMember(supabase);
    if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
    }
    const { orgId, userId } = access;

    const { phone } = await params;
    if (!phone || !PHONE_REGEX.test(phone)) {
        return NextResponse.json(
            { error: 'Invalid phone number' },
            { status: 400 }
        );
    }

    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return NextResponse.json(
            { error: 'Invalid multipart body' },
            { status: 400 }
        );
    }

    const fileEntry = formData.get('file');
    if (!(fileEntry instanceof File)) {
        return NextResponse.json(
            { error: 'Missing "file" field or not a File' },
            { status: 400 }
        );
    }

    if (!ALLOWED_MIME.has(fileEntry.type)) {
        return NextResponse.json(
            { error: `Only PDF allowed (got ${fileEntry.type || 'unknown'})` },
            { status: 400 }
        );
    }

    if (fileEntry.size === 0) {
        return NextResponse.json({ error: 'File is empty' }, { status: 400 });
    }
    if (fileEntry.size > MAX_BYTES) {
        return NextResponse.json(
            { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
            { status: 413 }
        );
    }

    // Read the file into a Buffer. For a 10 MB cap this is fine; for larger
    // ceilings we'd want to stream directly to Storage instead.
    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Path convention: {org_id}/{phone}/{uuid}.pdf — the org prefix is what the
    // storage policy checks; the UUID prevents name collisions and avoids
    // leaking client-supplied filenames into Storage.
    const objectKey = proposalObjectKey(orgId, phone, randomUUID());

    const { error: storageErr } = await supabase.storage
        .from('proposals')
        .upload(objectKey, buffer, {
            contentType: 'application/pdf',
            cacheControl: 'no-store',
            upsert: false,
        });

    if (storageErr) {
        console.error('Storage upload failed', storageErr);
        return NextResponse.json(
            { error: `Storage upload failed: ${storageErr.message}` },
            { status: 500 }
        );
    }

    // Insert the proposal row. We don't mark sent_at yet — the admin still
    // needs to click "Send" in the dialog after previewing.
    const proposalRef = generateProposalRef(phone, new Date());
    const { data: inserted, error: insertErr } = await supabase
        .from('proposals')
        .insert({
            org_id: orgId,
            lead_phone: phone,
            source: 'uploaded',
            file_path: objectKey,
            proposal_ref: proposalRef,
            created_by: userId,
        })
        .select('id, proposal_ref')
        .single();

    if (insertErr || !inserted) {
        // Best-effort cleanup so we don't leak orphan files in Storage.
        await supabase.storage.from('proposals').remove([objectKey]).catch(() => {});
        return NextResponse.json(
            { error: `Insert failed: ${insertErr?.message ?? 'unknown'}` },
            { status: 500 }
        );
    }

    return NextResponse.json({
        ok: true,
        proposal_id: inserted.id,
        proposal_ref: inserted.proposal_ref,
        file_path: objectKey,
        original_filename: fileEntry.name,
        size_bytes: fileEntry.size,
    });
}
