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
 * Structure-aware chunking for RAG.
 *
 * The previous version sliced the text every `chunkSize` characters blindly,
 * which cut sentences, headings and table rows in half — hurting retrieval
 * relevance. This version splits on natural boundaries first (blank-line
 * separated paragraphs, then lines), greedily packs them up to `chunkSize`,
 * and carries an `overlap` tail between chunks so context isn't lost at the
 * seams. Oversized single blocks fall back to a hard slice. This is the
 * RecursiveCharacterTextSplitter idea, kept dependency-free.
 *
 * Signature is unchanged so callers (the ingest route) need no edits.
 */
export function chunkText(text: string, chunkSize = 1500, overlap = 300): string[] {
    if (!text) return [];
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    if (normalized.length <= chunkSize) return [normalized];

    // 1. Break into blocks on blank lines (paragraphs / markdown sections).
    //    A paragraph longer than chunkSize is further broken by lines, and any
    //    single line longer than chunkSize is hard-sliced as a last resort.
    const blocks: string[] = [];
    for (const para of normalized.split(/\n{2,}/)) {
        const p = para.trim();
        if (!p) continue;
        if (p.length <= chunkSize) {
            blocks.push(p);
            continue;
        }
        for (const line of p.split('\n')) {
            const ln = line.trim();
            if (!ln) continue;
            if (ln.length <= chunkSize) {
                blocks.push(ln);
            } else {
                for (let i = 0; i < ln.length; i += chunkSize) {
                    blocks.push(ln.slice(i, i + chunkSize));
                }
            }
        }
    }

    // 2. Greedily pack blocks into chunks, carrying an overlap tail forward.
    const chunks: string[] = [];
    let current = '';
    for (const block of blocks) {
        const candidate = current ? `${current}\n\n${block}` : block;
        if (candidate.length <= chunkSize) {
            current = candidate;
            continue;
        }
        if (current) {
            chunks.push(current);
            const tail = current.length > overlap ? current.slice(-overlap) : current;
            current = `${tail}\n\n${block}`;
        } else {
            current = block;
        }
        // tail + block may still exceed the limit → hard-slice the remainder.
        while (current.length > chunkSize) {
            chunks.push(current.slice(0, chunkSize));
            current = current.slice(chunkSize - overlap);
        }
    }
    if (current.trim()) chunks.push(current);

    return chunks;
}
