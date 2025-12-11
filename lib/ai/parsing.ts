import { PDFParse } from 'pdf-parse';

export async function parseFile(fileBuffer: Buffer, fileType: string): Promise<string> {
    if (fileType === 'application/pdf') {
        try {
            const parser = new PDFParse({ data: fileBuffer });
            const data = await parser.getText();
            return data.text;
        } catch (error) {
            console.error('Error parsing PDF:', error);
            throw new Error('Failed to parse PDF file. Please ensure it is a valid PDF.');
        }
    } else {
        // Assume text/plain or markdown
        return fileBuffer.toString('utf-8');
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
