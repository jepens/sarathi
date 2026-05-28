import { createClient } from '@/lib/supabase/server';
import { generateEmbedding } from '@/lib/ai/embedding';
import { chunkText } from '@/lib/ai/parsing';
import { NextResponse } from 'next/server';

// In-dashboard knowledge editor backend.
//   GET            → list editor-authored sources (id, title, updated_at)
//   GET ?title=    → return one source's canonical content (for editing)
//   POST {title,content} → upsert kb_sources, then re-chunk + re-embed into
//                          `documents` (delete-by-source, then insert)
//   DELETE ?title= → delete the source + its derived chunks
//
// Embeddings are generated synchronously here (reusing the same chunkText +
// generateEmbedding the file-upload path uses). Fine for a small curated KB;
// for a large/growing KB switch to an async embedding queue.

export const runtime = 'nodejs';

const FILE_TYPE = 'text/markdown';
const MAX_CONTENT = 100_000; // ~100 KB of text — generous for a curated doc

export async function GET(request: Request) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const title = new URL(request.url).searchParams.get('title');

    if (title) {
        const { data, error } = await supabase
            .from('kb_sources')
            .select('id, title, content, updated_at')
            .eq('title', title)
            .maybeSingle();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json({ source: data });
    }

    const { data, error } = await supabase
        .from('kb_sources')
        .select('id, title, updated_at')
        .order('updated_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ sources: data ?? [] });
}

export async function POST(request: Request) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: { title?: unknown; content?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!title) return NextResponse.json({ error: 'Judul wajib diisi' }, { status: 400 });
    if (!content) return NextResponse.json({ error: 'Konten tidak boleh kosong' }, { status: 400 });
    if (content.length > MAX_CONTENT) {
        return NextResponse.json(
            { error: `Konten terlalu panjang (maks ${MAX_CONTENT} karakter)` },
            { status: 413 }
        );
    }

    // Embed ALL chunks BEFORE any destructive write. If embedding fails we
    // return without having touched kb_sources or deleted the old chunks, so
    // the previously-saved version stays intact (no partial/corrupt state).
    const chunks = chunkText(content);
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            embeddings.push(await generateEmbedding(chunks[i]));
        } catch (e) {
            console.error('Embedding failed for chunk', i, e);
            return NextResponse.json({ error: 'Gagal membuat embedding' }, { status: 500 });
        }
    }

    // 1. Upsert the canonical editable source.
    const { error: upsertErr } = await supabase
        .from('kb_sources')
        .upsert({ title, content, created_by: user.id, updated_at: new Date().toISOString() }, { onConflict: 'title' });
    if (upsertErr) {
        return NextResponse.json({ error: `Gagal menyimpan sumber: ${upsertErr.message}` }, { status: 500 });
    }

    // 2. Replace derived chunks: remove old ones for this title, then insert
    //    the freshly-embedded set in one batch.
    const { error: delErr } = await supabase
        .from('documents')
        .delete()
        .eq('metadata->>source', title);
    if (delErr) {
        return NextResponse.json({ error: `Gagal membersihkan chunk lama: ${delErr.message}` }, { status: 500 });
    }

    const nowIso = new Date().toISOString();
    const rows = chunks.map((chunk, i) => ({
        content: chunk,
        metadata: {
            file_name: title,
            source: title,
            file_type: FILE_TYPE,
            origin: 'editor',
            chunk_index: i,
            created_at: nowIso,
        },
        embedding: embeddings[i],
    }));

    const { error: insErr } = await supabase.from('documents').insert(rows);
    if (insErr) {
        console.error('Insert chunks failed', insErr);
        return NextResponse.json({ error: `Gagal menyimpan chunk: ${insErr.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, title, chunks: chunks.length });
}

export async function DELETE(request: Request) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const title = new URL(request.url).searchParams.get('title');
    if (!title) return NextResponse.json({ error: 'title wajib' }, { status: 400 });

    // Delete derived chunks first, then the canonical source.
    const { error: docErr } = await supabase.from('documents').delete().eq('metadata->>source', title);
    if (docErr) return NextResponse.json({ error: docErr.message }, { status: 500 });

    const { error: srcErr } = await supabase.from('kb_sources').delete().eq('title', title);
    if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
}
