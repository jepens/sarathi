import { createClient } from '@/lib/supabase/server'
import { generateEmbedding } from '@/lib/ai/embedding'
import { chunkText, parseFile } from '@/lib/ai/parsing'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
    try {
        const { filePath, fileType } = await request.json()
        const supabase = await createClient()

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
                content: chunk,
                metadata: {
                    source: filePath,
                    file_name: filePath,
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
