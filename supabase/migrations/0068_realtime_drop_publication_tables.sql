-- Fase 1 — org Realtime bus, CONTRACT phase (tracker 1.9; audit KEA-15,
-- PER-8): supabase_realtime publishes no table any more.
--
-- Why (KEA-15). realtime.apply_rls skips the RLS check for DELETE events and
-- sends every Postgres Changes subscriber of a published table the
-- primary-key columns its role may SELECT. As long as a table is published,
-- every signed-in user of ANY org can therefore receive every org's deletes
-- (org_id + customer phone_number on whatsapp_chats and chat_labels): filters
-- are chosen by the client and DELETE events cannot be filtered. Only an
-- EMPTY publication closes this: with no table published, no Postgres Changes
-- stream exists for anyone, signed in or anon. 0063 closed the anon-key
-- variant; 0064 added the replacement (one private Broadcast topic per org,
-- 'org:<uuid>', members only); the client PR that ships this migration moves
-- every dashboard view onto it (components/realtime/org-realtime-provider.tsx:
-- one private channel per tab, views refetch through PostgREST under RLS).
--
--   drops public.whatsapp_chats, public.whatsapp_messages, public.labels and
--   public.chat_labels from supabase_realtime where present (idempotent: a
--   re-run, or a database where they were never published, is a no-op), then
--   refuses to finish if the publication still publishes anything: a table
--   published by hand, or from another schema, keeps the leak open and must be
--   reviewed first (production 2026-10-16, read-only: not FOR ALL TABLES, no
--   schema member, owner postgres, exactly these 4 tables). orders was never
--   published; it is live through 0064.
--
-- Deploy order (CONTRACT: tabs running the old bundle depend on these events;
-- its ContactList and in-tab notifications have no poll and would go silent):
--   1. 0064 applied and verified (done 2026-10-16).
--   2. build boundary: this PR ships in its OWN Easypanel build, not together
--      with another contract (e.g. the chat-media contract 0067): rolling it
--      back then concerns only this migration. Merge, redeploy the app
--      service, confirm the new build is live (the Next.js build id in the
--      page payload changes) and smoke-test with two tabs: the console shows
--      "[realtime] org:<uuid> live (SUBSCRIBED)" and no CHANNEL_ERROR; an
--      inbound message updates the inbox, the open chat and alerts; a label
--      toggled in tab A shows in tab B; a contact rename shows in Contacts; a
--      booking shows in Bookings without a reload.
--   3. reload every open dashboard tab (ask the test-tenant accounts to
--      reload or sign out), then, read-only:
--        select count(*) from realtime.subscription;  -- must be 0
--      (each row is a tab still subscribed to Postgres Changes).
--   4. only then apply THIS migration (apply_migration, LF git blob) and check
--        select count(*) from pg_publication_tables
--        where pubname = 'supabase_realtime';  -- must be 0
--      then repeat the smoke test.
--   5. the owner turns off "Allow public access" (Dashboard > Realtime >
--      Settings): joins without config.private are then refused. The switch
--      disconnects every socket once: a tab that was NOT reloaded must recover
--      on its own (the provider re-joins) — repeat the smoke test in one.
--   6. follow-up PR: refresh fingerprint/production.txt and delete the 0068
--      pending block of expected-diff.txt.
-- The tenant-2 gate (no second tenant with real data) stays closed until 4
-- and 5 are done.
--
-- Tenant-2 rule: once a SECOND tenant has real data, NEVER roll this back by
-- re-adding tables to supabase_realtime: every signed-in user of every org
-- would receive the other orgs' DELETE keys again (KEA-15). Degrade to polling
-- instead (revert only the failing client build: ChatList 30 s and ChatWindow
-- 10 s keep polling, the other live views and the in-tab alerts pause), or
-- first close the tenant-2 gate again (suspend the other tenants' access).
-- See supabase/README.md, "Contract migrations".
--
-- Rollback — ONLY while Sailendra is the only tenant with real data, and
-- only together with the code (after a contract, rolling FORWARD with a patch
-- build is the default):
--   1. turn "Allow public access" back on if it was turned off;
--   2. alter publication supabase_realtime add table public.whatsapp_chats,
--        public.whatsapp_messages, public.labels, public.chat_labels;
--   3. deploy the previous code (a revert of this PR on main, then an
--      Easypanel deploy; redeploying an older build is not documented);
--   4. refresh fingerprint/production.txt.
-- The 0064 triggers can stay.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

do $$
declare
    t text;
    v_left text;
begin
    foreach t in array array['whatsapp_chats', 'whatsapp_messages', 'labels', 'chat_labels']
    loop
        if exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
        ) then
            execute format('alter publication supabase_realtime drop table public.%I', t);
        end if;
    end loop;

    select string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename)
      into v_left
      from pg_publication_tables
     where pubname = 'supabase_realtime';
    if v_left is not null then
        raise exception 'supabase_realtime still publishes %: KEA-15 needs an empty publication (review these first)', v_left;
    end if;
end $$;
