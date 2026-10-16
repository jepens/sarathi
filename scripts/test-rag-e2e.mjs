// End-to-end RAG smoke test.
//
// Demonstrates the critical fix: match_documents under the ANON key (the old
// webhook behaviour) returns nothing (anon EXECUTE is revoked since migration
// 0058, and documents/products are authenticated-only under RLS), whereas the
// SERVICE ROLE key (the new behaviour) retrieves the org's curated KB. Then
// runs a grounded GPT-4o answer so you can see Nindra actually citing the
// knowledge base.
//
// match_documents is fail-closed per org since migration 0061: a call without
// filter_org_id returns 0 rows even under the service role, so the script
// always passes the org. --org=<uuid> wins; otherwise the deployment's default
// org (platform_settings.default_org_id = Sailendra).
//
// Run:  node --env-file=.env.local scripts/test-rag-e2e.mjs ["your question"] [--org=<uuid>]
// Safe: no WhatsApp send, no DB writes.

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!url || !anonKey || !serviceKey || !openaiKey) {
    console.error('Missing env. Run with: node --env-file=.env.local scripts/test-rag-e2e.mjs');
    process.exit(1);
}

const args = process.argv.slice(2);
const question =
    args.find((a) => !a.startsWith('--')) ||
    'Berapa harga paket gathering dan bisa handle berapa peserta?';

const openai = new OpenAI({ apiKey: openaiKey });
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// Org whose KB is searched (see header). platform_settings is service-role only.
let orgId = args.find((a) => a.startsWith('--org='))?.slice('--org='.length);
if (!orgId) {
    const { data, error } = await admin
        .from('platform_settings')
        .select('value')
        .eq('key', 'default_org_id')
        .maybeSingle();
    if (error) {
        console.error(`Gagal membaca default_org_id: ${error.message}`);
        process.exit(1);
    }
    orgId = data?.value;
}
if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
    console.error('Org tujuan tidak diketahui. Jalankan dengan --org=<uuid>.');
    process.exit(1);
}
console.log(`Org: ${orgId}`);

console.log(`\nPertanyaan uji: "${question}"`);

const embedding = (
    await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: question.replace(/\n/g, ' '),
    })
).data[0].embedding;

async function retrieve(key, label) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await sb.rpc('match_documents', {
        query_embedding: embedding,
        match_threshold: 0.1,
        match_count: 25,
        filter_org_id: orgId,
    });
    const n = data?.length ?? 0;
    console.log(`\n[${label}] match_documents → ${error ? 'ERROR: ' + error.message : n + ' chunk'}`);
    return data ?? [];
}

// 1) Old behaviour (webhook path was effectively this): anon → blocked
//    (no EXECUTE since 0058; RLS on documents before that).
await retrieve(anonKey, 'ANON  (perilaku LAMA / webhook)');

// 2) New behaviour: service role bypasses RLS → the org's KB is retrieved.
const docs = await retrieve(serviceKey, 'SERVICE ROLE (fix baru)');
docs.slice(0, 6).forEach((d, i) =>
    console.log(`   ${i + 1}. [${(d.similarity ?? 0).toFixed(3)}] ${d.content.slice(0, 90).replace(/\s+/g, ' ')}…`)
);

// 3) Grounded answer using the retrieved context.
const context = docs.map((d) => d.content).join('\n\n');
const chat = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.3,
    messages: [
        {
            role: 'system',
            content:
                'Kamu Nindra, asisten dari Sailendra Organizer (Event Organizer). ' +
                'Jawab pertanyaan customer dalam Bahasa Indonesia HANYA berdasarkan konteks di bawah. ' +
                'Jika info tidak ada di konteks, katakan akan dicek tim. Jangan mengarang.\n\n' +
                `Konteks:\n${context || '(kosong)'}`,
        },
        { role: 'user', content: question },
    ],
});

console.log('\n=== Jawaban AI (grounded ke KB) ===\n');
console.log(chat.choices[0].message.content);
console.log('\n=== selesai ===');
