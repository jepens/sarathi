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
 * Improved chunking strategy with larger chunks and better overlap
 * for enhanced context preservation in RAG
 * 
 * Changes from previous:
 * - Chunk size: 1000 → 1500 characters (50% increase)
 * - Overlap: 200 → 300 characters (50% increase)
 */
export function chunkText(text: string, chunkSize = 1500, overlap = 300): string[] {
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        const chunk = text.slice(start, end);
        chunks.push(chunk);
        start += chunkSize - overlap; // Overlap for context continuity
    }

    return chunks;
}
