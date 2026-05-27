-- Final security hardening per Supabase advisor:
--   #8: document service-role-only intent on message_queue + rate_limits
--       (RLS-enabled but no policy → silent deny, advisor INFO)
--   #9: move vector + pg_trgm extensions out of public schema

-- #8 — Explicit "no anon/authenticated access" policies. These tables are
-- service-role-only (the queue worker + rate limiter run in the webhook
-- path). service_role has BYPASSRLS so it works regardless of policies.
-- The deny policies just document intent and silence the advisor.

create policy "service_role only" on public.message_queue
    for all to anon, authenticated using (false) with check (false);

create policy "service_role only" on public.rate_limits
    for all to anon, authenticated using (false) with check (false);

-- #9 — Move extensions out of public. Existing column types (documents.embedding,
-- products.embedding both `vector(1536)`) reference the type by OID so they
-- continue working after the schema move. Functions that reference extension
-- operators (the <=> cosine distance in match_documents / match_products)
-- need `extensions` in their search_path post-move.

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

alter extension vector set schema extensions;
alter extension pg_trgm set schema extensions;

-- Update the two RPC functions to include `extensions` in their pinned
-- search_path. Signature uses extensions.vector since that's the new
-- fully-qualified type name (Postgres also recognises the old `vector`
-- but being explicit avoids any session-search-path dependency at ALTER
-- time).
alter function public.match_documents(extensions.vector, double precision, integer)
    set search_path = 'public, extensions';
alter function public.match_products(extensions.vector, double precision, integer)
    set search_path = 'public, extensions';
