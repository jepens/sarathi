import { generateEmbedding } from '@/lib/ai/embedding'
import { chunkText, parseFile } from '@/lib/ai/parsing'
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context'
import { isOrgScopedObjectPath } from '@/lib/storage/object-paths'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
    try {
        // Stamp each chunk with the uploader's org so retrieval (filter_org_id)
        // and the documents-table RLS isolate this tenant's KB. Without it the
        // row falls to the column DEFAULT (Sailendra) and RLS rejects the insert
        // for any other tenant.
        const access = await requireOrgContext()
        if (!access.ok) return accessDeniedResponse(access)
        const { supabase, orgId } = access

        const { filePath, fileType } = await request.json()

        // The object must live in THIS org's folder ("<org_id>/...", no '..'):
        // never ingest — and stamp with this org — a file from another org's
        // folder or an arbitrary bucket path (KEA-18).
        if (!isOrgScopedObjectPath(filePath, orgId)) {
            return NextResponse.json({ error: 'Path file tidak valid' }, { status: 400 })
        }
        if (typeof fileType !== 'string' || fileType.length > 200) {
            return NextResponse.json({ error: 'Tipe file tidak valid' }, { status: 400 })
        }

        // The uploaded object lives at "<org_id>/<ts>_<name>". Keep the full path
        // in metadata.source (used to download + later delete the object), but
        // expose only the "<ts>_<name>" portion as file_name so the dashboard
        // list doesn't show the org UUID (matches the pre-multi-tenant display).
        const displayName = filePath.slice(filePath.indexOf('/') + 1)

        // The dashboard lists a KB entry by its documents rows, and DELETE
        // /api/documents removes an object through them: an upload that ends
        // with no row (an empty or unreadable file, or a failure before the
        // first row) could never be seen or deleted again (tracker 3.9, UU
        // PDP). Remove such an upload; once a row is stored the entry is
        // listed and deletable, so the object stays. Rows are checked in the
        // database, not only counted here: an insert whose reply was lost may
        // still have committed.
        let stored = 0
        const dropUpload = async () => {
            const { data: rows, error: rowsError } = await supabase
                .from('documents')
                .select('id')
                .eq('org_id', orgId)
                .eq('metadata->>source', filePath)
                .limit(1)
            if (rowsError || (rows ?? []).length > 0) return // listed (or unknown): keep the file
            const { data: removed, error } = await supabase.storage.from('documents').remove([filePath])
            if (error) console.error('Ingest: removing the unprocessed upload failed:', error.message)
            else if (!removed?.length) console.error('Ingest: the unprocessed upload was not removed (nothing matched)')
        }

        try {
            // 1. Download file from Supabase Storage
            const { data: fileData, error: downloadError } = await supabase.storage
                .from('documents')
                .download(filePath)

            if (downloadError) {
                console.error('Ingest download failed:', downloadError)
                await dropUpload()
                return NextResponse.json({ error: 'Failed to download file' }, { status: 500 })
            }

            // 2. Parse file content
            const arrayBuffer = await fileData.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)
            const text = await parseFile(buffer, fileType)

            // 3. Chunk text
            const chunks = chunkText(text)
            if (chunks.length === 0) {
                await dropUpload()
                return NextResponse.json({ error: 'File kosong atau teksnya tidak bisa dibaca.' }, { status: 422 })
            }

            // 4. Generate embeddings and store in DB
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const embedding = await generateEmbedding(chunk)

                const { error: insertError } = await supabase.from('documents').insert({
                    org_id: orgId,
                    content: chunk,
                    metadata: {
                        source: filePath,
                        file_name: displayName,
                        file_type: fileType,
                        chunk_index: i,
                        created_at: new Date().toISOString(),
                    },
                    embedding,
                })

                if (insertError) {
                    console.error('Error inserting document:', insertError)
                } else {
                    stored++
                }
            }

            if (stored === 0) {
                await dropUpload()
                return NextResponse.json({ error: 'Gagal menyimpan dokumen. Silakan coba lagi.' }, { status: 500 })
            }
            return NextResponse.json({ success: true, chunks: stored })
        } catch (error) {
            if (stored === 0) await dropUpload()
            throw error
        }
    } catch (error) {
        // Details stay in the server log: the message may come from OpenAI or
        // the platform config (a masked key, quota, .env hints), never meant
        // for a tenant's user.
        console.error('Ingestion error:', error)
        return NextResponse.json({ error: 'Gagal memproses dokumen. Silakan coba lagi.' }, { status: 500 })
    }
}
