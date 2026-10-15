-- Fase 0 — tenant isolation hotfix (audit 2026-10-15: KEA-3, KEA-4, KEA-5,
-- KEA-25; KEA-23 relies on the push_subscriptions.user_id added here).
--
-- Closes the "any signed-in user sees every org" holes that the single-tenant
-- era left behind, without changing what members of the Sailendra (default)
-- org can do:
--
--   a. labels / chat_labels / quick_replies: replace the USING(true) policies
--      with the standard private.is_org_member(org_id) policy (KEA-3). For
--      chat_labels the WITH CHECK also requires the label to belong to the same
--      org (the label_id FK check ignores RLS, so it can't enforce that).
--   b. push_subscriptions: add an owning user_id and scope rows to
--      "my own device, in an org I belong to" (KEA-3, KEA-23).
--   c. storage: chat-media + proposals objects are only reachable by members of
--      the org named in the first path segment ("<org_id>/...") (KEA-4).
--   d. reserve_meeting_slot: service_role only (KEA-5). Its only caller is the
--      AI tool executor (lib/ai/tools.ts) through the service-role client.
--   e. match_documents / match_products: no longer executable by anon (KEA-25).
--
-- NOT done here (Fase 1): dropping the DEFAULT org_id = seed-org column
-- defaults, and making filter_org_id mandatory in the match_* functions.
--
-- Data effect: push_subscriptions rows without an owner are DELETED (step b).
-- Ownership of the existing row(s) is unknowable (the table never recorded the
-- user; 1 row in production on 2026-10-15). The affected browser re-registers
-- automatically on the next dashboard load (the notification provider
-- re-subscribes whenever notifications are enabled), now with its user_id.
--
-- Storage follow-up (not in this migration): chat-media is still a PUBLIC
-- bucket, so reads through the public URL bypass these policies. Making it
-- private + serving short-lived signed URLs is tracked separately (KEA-4 step 2).
-- All 27 existing chat-media objects already live under the seed org's
-- "<org_id>/" prefix and the proposals bucket is empty, so no object loses
-- access to its own org.
--
-- Reversibility: everything except the push_subscriptions row delete can be
-- undone with a follow-up migration:
--   - a. recreate "auth full access" (for all to authenticated using (true)
--        with check (true)) and drop "org members full access" on the 3 tables;
--   - b. drop the push policy, recreate "auth full access", then
--        `alter table public.push_subscriptions drop column user_id;`
--        (deleted rows come back only when their browsers re-subscribe);
--   - c. drop the two org policies and recreate "chat-media auth manage" /
--        "proposals bucket auth all" (bucket_id check only, see 0048 / 0004);
--   - d. `grant execute on function public.reserve_meeting_slot(...) to authenticated;`
--   - e. `grant execute on function public.match_documents(...) / match_products(...) to anon;`
--
-- Re-runnable: policies are dropped-if-exists before being (re)created, column
-- and index creation are guarded, and grants/revokes are idempotent.
--
-- No explicit begin/commit, like every other migration: the Supabase CLI /
-- apply_migration already wrap each file in one transaction, and an inner
-- COMMIT would end it early (before the runner's own bookkeeping).

-- ---------------------------------------------------------------------------
-- a. labels, chat_labels, quick_replies → org members only
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
    foreach t in array array['labels', 'quick_replies']
    loop
        execute format('drop policy if exists "auth full access" on public.%I', t);
        execute format('drop policy if exists "org members full access" on public.%I', t);
        execute format(
            'create policy "org members full access" on public.%I for all to authenticated using (private.is_org_member(org_id)) with check (private.is_org_member(org_id))',
            t
        );
    end loop;
end $$;

-- chat_labels: same membership rule, plus the attached label must be one of the
-- SAME org's labels — otherwise a member of org B could attach org A's label
-- uuid to an org-B chat (the FK to labels(id) is checked without RLS). The
-- subquery runs under the caller's labels RLS, which is the same membership
-- rule. A composite FK (org_id, label_id) → labels(org_id, id) is the Fase 1
-- structural fix.
drop policy if exists "auth full access" on public.chat_labels;
drop policy if exists "org members full access" on public.chat_labels;
create policy "org members full access" on public.chat_labels
    for all to authenticated
    using (private.is_org_member(org_id))
    with check (
        private.is_org_member(org_id)
        and exists (
            select 1 from public.labels l
            where l.id = chat_labels.label_id
              and l.org_id = chat_labels.org_id
        )
    );

-- ---------------------------------------------------------------------------
-- b. push_subscriptions → owned by a user, scoped to that user's orgs
-- ---------------------------------------------------------------------------
-- default auth.uid() stamps the subscribing user on inserts made through the
-- user's own session; server code also sets it explicitly.
alter table public.push_subscriptions
    add column if not exists user_id uuid
        default auth.uid()
        references auth.users(id) on delete cascade;

-- Rows from before this migration have no recorded owner (auth.uid() is null
-- while the migration runs, so the default above leaves them null). See the
-- header: the device simply re-subscribes.
delete from public.push_subscriptions where user_id is null;

alter table public.push_subscriptions alter column user_id set not null;

create index if not exists push_subscriptions_user_idx
    on public.push_subscriptions (user_id);

drop policy if exists "auth full access" on public.push_subscriptions;
drop policy if exists "own subscriptions in member orgs" on public.push_subscriptions;
create policy "own subscriptions in member orgs" on public.push_subscriptions
    for all to authenticated
    using (user_id = (select auth.uid()) and private.is_org_member(org_id))
    with check (user_id = (select auth.uid()) and private.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- c. storage.objects → chat-media + proposals scoped by the "<org_id>/" prefix
-- ---------------------------------------------------------------------------
-- The CASE guard only casts the first folder when it is a well-formed uuid, so
-- a root-level object or a non-uuid folder is simply denied (never a cast
-- error that would fail the whole request). No COALESCE fallback to the seed
-- org (unlike the legacy documents policy in 0038).
drop policy if exists "chat-media auth manage" on storage.objects;
drop policy if exists "chat-media org members" on storage.objects;
create policy "chat-media org members" on storage.objects
    for all to authenticated
    using (
        bucket_id = 'chat-media'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then private.is_org_member(((storage.foldername(name))[1])::uuid)
            else false
        end
    )
    with check (
        bucket_id = 'chat-media'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then private.is_org_member(((storage.foldername(name))[1])::uuid)
            else false
        end
    );

drop policy if exists "proposals bucket auth all" on storage.objects;
drop policy if exists "proposals org members" on storage.objects;
create policy "proposals org members" on storage.objects
    for all to authenticated
    using (
        bucket_id = 'proposals'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then private.is_org_member(((storage.foldername(name))[1])::uuid)
            else false
        end
    )
    with check (
        bucket_id = 'proposals'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then private.is_org_member(((storage.foldername(name))[1])::uuid)
            else false
        end
    );

-- ---------------------------------------------------------------------------
-- d. reserve_meeting_slot → service_role only
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER with a caller-chosen p_org: an authenticated session could
-- book into / probe any org. Do NOT "fix" this with is_org_member(p_org) inside
-- the function — auth.uid() is null for the service role, which would break the
-- webhook path. The service-role client is the only legitimate caller.
revoke execute on function public.reserve_meeting_slot(
    uuid, text, text, timestamptz, text, timestamptz, timestamptz, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.reserve_meeting_slot(
    uuid, text, text, timestamptz, text, timestamptz, timestamptz, integer, integer, integer
) to service_role;

-- ---------------------------------------------------------------------------
-- e. match_documents / match_products → no anon execute
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER, so RLS still applies for authenticated callers
-- (/api/search); lib/ai/rag.ts calls them with the service-role client.
revoke execute on function public.match_documents(extensions.vector, double precision, integer, uuid)
    from public, anon;
grant execute on function public.match_documents(extensions.vector, double precision, integer, uuid)
    to authenticated, service_role;

revoke execute on function public.match_products(extensions.vector, double precision, integer, uuid)
    from public, anon;
grant execute on function public.match_products(extensions.vector, double precision, integer, uuid)
    to authenticated, service_role;
