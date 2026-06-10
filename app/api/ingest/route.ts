import { createClient } from '@/lib/supabase/server'
import { generateEmbedding } from '@/lib/ai/embedding'
import { chunkText, parseFile } from '@/lib/ai/parsing'
import { getCurrentOrgId } from '@/lib/settings/org-context'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Stamp each chunk with the uploader's org so retrieval (filter_org_id)
        // and the documents-table RLS isolate this tenant's KB. Without it the
        // row falls to the column DEFAULT (Sailendra) and RLS rejects the insert
        // for any other tenant.
        const orgId = await getCurrentOrgId(supabase)
        if (!orgId) {
            return NextResponse.json({ error: 'No organization for current user' }, { status: 403 })
        }

        const { filePath, fileType } = await request.json()

        // The uploaded object lives at "<org_id>/<ts>_<name>". Keep the full path
        // in metadata.source (used to download + later delete the object), but
        // expose only the "<ts>_<name>" portion as file_name so the dashboard
        // list doesn't show the org UUID (matches the pre-multi-tenant display).
        const displayName =
            typeof filePath === 'string' && filePath.includes('/')
                ? filePath.slice(filePath.indexOf('/') + 1)
                : filePath

        // 1. Download file from Supabase Storage
        const { data: fileData, error: downloadError } = await supabase.storage
            .from('documents')
            .download(filePath)

        if (downloadError) {
            return NextResponse.json({ error: 'Failed to download file', details: downloadError }, { status: 500 })
        }

        // 2. Parse file content
        const arrayBuffer = await fileData.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        const text = await parseFile(buffer, fileType)

        // 3. Chunk text
        const chunks = chunkText(text)

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
            }
        }

        return NextResponse.json({ success: true, chunks: chunks.length })
    } catch (error) {
        console.error('Ingestion error:', error)
        const errorMessage = error instanceof Error ? error.message : 'Internal Server Error'
        return NextResponse.json({ error: errorMessage, details: error }, { status: 500 })
    }
}
