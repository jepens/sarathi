export async function parseFile(fileBuffer: Buffer, fileType: string): Promise<string> {
    if (fileType === 'application/pdf') {
        // PDF parsing in server-side Next.js is complex due to worker requirements
        // For production, consider using:
        // 1. External service like Unstructured.io API
        // 2. Separate microservice for PDF processing
        // 3. Client-side processing with Web Workers
        // For now, we'll throw a helpful error
        throw new Error(
            'PDF parsing is not yet supported. Please upload .txt or .md files, ' +
            'or convert your PDF to text first. PDF support will be added in a future update.'
        )
    } else {
        // Assume text/plain or markdown
        return fileBuffer.toString('utf-8')
    }
}

/**
 * Smart chunking that respects natural text boundaries (paragraphs, sentences)
 * This improves embedding quality by keeping related context together.
 */
export function chunkText(text: string, chunkSize: number = 1000, overlap: number = 200): string[] {
    if (!text) return [];

    const chunks: string[] = [];

    // Split by double newline (paragraphs) first
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        // If adding this paragraph exceeds chunk size, verify if we need to split the paragraph itself
        if (currentChunk.length + paragraph.length + 2 > chunkSize) {

            // If current chunk is not empty, push it first
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                // Start new chunk with overlap from previous (simple approach: just start fresh for now to avoid complexity)
                // For better overlap, we'd need to keep last N chars. 
                // Given "avoid complexity", we'll stick to simple accumulation but handle large paragraphs.
                currentChunk = '';
            }

            // If the paragraph itself is larger than chunk size, we need to split it by sentences
            if (paragraph.length > chunkSize) {
                const sentences = paragraph.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [paragraph];

                for (const sentence of sentences) {
                    if (currentChunk.length + sentence.length > chunkSize) {
                        if (currentChunk) chunks.push(currentChunk.trim());
                        currentChunk = sentence;
                    } else {
                        currentChunk += (currentChunk ? ' ' : '') + sentence;
                    }
                }
            } else {
                currentChunk = paragraph;
            }
        } else {
            // Add paragraph to current chunk
            currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        }
    }

    // Add remaining chunk
    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    // Fallback: If any chunk is still significantly larger than limit (e.g. huge code block without spaces), 
    // force split it (legacy method) to ensure it fits context window
    return chunks.flatMap(chunk => {
        if (chunk.length <= chunkSize * 1.5) return [chunk]; // Allow slightly larger chunks if they are coherent units

        // Force split huge chunks
        const subChunks: string[] = [];
        let i = 0;
        while (i < chunk.length) {
            subChunks.push(chunk.slice(i, i + chunkSize));
            i += chunkSize - overlap;
        }
        return subChunks;
    });
}
