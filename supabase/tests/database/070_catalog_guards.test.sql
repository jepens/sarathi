-- Catalog guards (audit KUA-13 recommendation 3): structural rules every
-- future migration must keep, so a new table / function / bucket policy that
-- forgets tenant isolation fails CI even before it gets its own test.
begin;
select plan(13);

-- 1. RLS is on for every table in public.
select is_empty(
    $$ select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and not c.relrowsecurity $$,
    'every public table has row level security enabled');

-- 2. No always-true policy for the client roles in public.
select is_empty(
    $$ select tablename || '.' || policyname from pg_policies
       where schemaname = 'public'
         and roles && array['public', 'anon', 'authenticated']::name[]
         and (qual = 'true' or with_check = 'true') $$,
    'no public policy is USING (true) / WITH CHECK (true) for client roles');

-- 3. Every public table with an org_id column is covered by at least one policy.
select is_empty(
    $$ select c.relname from pg_class c
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and not exists (select 1 from pg_policies p
                         where p.schemaname = 'public' and p.tablename = c.relname) $$,
    'every org_id table has at least one RLS policy');

-- 4. ...and each of its policies is scoped to the caller: org membership
--    (is_org_member) or a hard deny. A policy scoped only to the caller's own
--    rows must compare user_id with auth.uid() for equality AND be on the
--    reviewed allowlist below; "auth.uid() IS NOT NULL" and the like (any
--    signed-in user of any tenant) therefore fail this guard.
select is_empty(
    $$ select p.tablename || '.' || p.policyname from pg_policies p
       where p.schemaname = 'public'
         and exists (select 1 from pg_attribute a
                     join pg_class c on c.oid = a.attrelid
                     where c.relnamespace = 'public'::regnamespace and c.relname = p.tablename
                       and a.attname = 'org_id' and not a.attisdropped)
         and (   not (coalesce(p.qual, 'false') = 'false'
                      or p.qual like '%is_org_member(%'
                      or (p.qual ~ 'user_id = (\( SELECT auth\.uid\(\) AS uid\)|auth\.uid\(\))'
                          and p.tablename || '.' || p.policyname = any (array[
                              'organization_members.read own memberships'])))
              or (p.with_check is not null
                  and not (p.with_check = 'false'
                           or p.with_check like '%is_org_member(%'
                           or (p.with_check ~ 'user_id = (\( SELECT auth\.uid\(\) AS uid\)|auth\.uid\(\))'
                               and p.tablename || '.' || p.policyname = any (array[
                                   'organization_members.read own memberships']))))) $$,
    'every policy on an org_id table is scoped to the caller''s org / own rows (or denies)');

-- 5. Every storage.objects policy is scoped to an org folder via is_org_member.
select is_empty(
    $$ select policyname from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and (coalesce(qual, '') not like '%private.is_org_member(%'
              or (with_check is not null and with_check not like '%private.is_org_member(%')) $$,
    'every storage.objects policy checks org membership of the path''s org folder');

-- 6. No SECURITY DEFINER function in public/private is executable by anon.
select is_empty(
    $$ select p.oid::regprocedure::text from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') $$,
    'no SECURITY DEFINER function is executable by anon');

-- 7. The SECURITY DEFINER functions authenticated users may call are exactly
--    these (a new one must be reviewed and added here on purpose).
select results_eq(
    $$ select p.oid::regprocedure::text from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
       order by 1 $$,
    array['delete_contact_cascade(uuid,text)', 'private.is_org_member(uuid)',
          'register_push_subscription(uuid,text,text,text,text)'],
    'authenticated can call only the reviewed SECURITY DEFINER functions');

-- 8. Such a function that takes an org (p_org) must check membership itself.
select is_empty(
    $$ select p.oid::regprocedure::text from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
         and 'p_org' = any (p.proargnames)
         and p.prosrc not like '%is_org_member(%' $$,
    'callable SECURITY DEFINER functions with p_org check is_org_member');

-- 9. Every app function pins its search_path (advisor function_search_path_mutable).
select is_empty(
    $$ select p.oid::regprocedure::text from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') $$,
    'every public/private function pins search_path');

-- 10. Realtime only publishes RLS-protected, org-scoped tables.
select is_empty(
    $$ select pt.tablename from pg_publication_tables pt
       join pg_class c on c.relname = pt.tablename and c.relnamespace = 'public'::regnamespace
       where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'
         and (not c.relrowsecurity
              or not exists (select 1 from pg_policies p
                             where p.schemaname = 'public' and p.tablename = pt.tablename
                               and p.qual like '%is_org_member(%')) $$,
    'every realtime-published table has RLS with an org-membership policy');

-- 11. anon holds no privilege on any relation in public (0063), whoever owns
--     it: tables, partitioned tables, views, materialized views and foreign
--     tables (table or column level; Realtime builds DELETE payloads from
--     has_column_privilege, so a column grant counts) and sequences
--     (USAGE/SELECT/UPDATE). Since 0063 what postgres creates in public gives
--     anon nothing. An object created by another role (the default ACL of
--     supabase_admin in public still grants anon, e.g. an extension installed
--     into public) or an explicit grant fails here until it is reviewed.
select is_empty(
    $$ select c.oid::regclass::text || ' (relkind ' || c.relkind::text || ')' from pg_class c
       where c.relnamespace = 'public'::regnamespace
         and (   (c.relkind in ('r', 'p', 'v', 'm', 'f')
                  and (has_table_privilege('anon', c.oid,
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
                       or has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))
              or (c.relkind = 'S'
                  and has_sequence_privilege('anon', c.oid, 'USAGE, SELECT, UPDATE'))) $$,
    'anon holds no privilege on any table, view or sequence in public');

-- 12. Realtime Authorization (0064): every realtime.messages policy only lets
--     a member RECEIVE the topic being joined: SELECT, for authenticated,
--     bound to that topic (topic = realtime.topic(); realtime.send leaves
--     realtime.topic set for the rest of a writer's transaction) and scoped
--     with is_org_member on the org the topic names. An INSERT/UPDATE/DELETE
--     (or ALL) policy would let clients send on org topics.
select is_empty(
    $$ select policyname from pg_policies
       where schemaname = 'realtime' and tablename = 'messages'
         and not (cmd = 'SELECT'
                  and roles = array['authenticated']::name[]
                  and coalesce(qual, '') like '%topic = ( SELECT realtime.topic() AS topic)%'
                  and coalesce(qual, '') like '%private.is_org_member(private.realtime_topic_org_id(%') $$,
    'every realtime.messages policy is SELECT for authenticated, bound to the joined topic and org-scoped');

-- 13. Unique keys are per org (KUA-5): every unique index on a public table
--     with org_id, primary keys included, has org_id among its KEY columns
--     (INCLUDE columns do not count). Exempt: a primary key made only of
--     surrogate columns (a default such as gen_random_uuid(), or an identity),
--     and these reviewed global keys:
--       push_subscriptions_endpoint_key: one row per browser endpoint, owned
--         by whoever is signed in on it now (D19, register_push_subscription,
--         0065);
--       whatsapp_integrations_phone_number_id_key: a WhatsApp number belongs
--         to one org (inbound routing by phone_number_id).
--     A new global key must be reviewed and added here on purpose.
select results_eq(
    $$ select ic.relname::text collate "default" from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_class ic on ic.oid = i.indexrelid
       where c.relnamespace = 'public'::regnamespace
         and i.indisunique
         and exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
         -- org_id is not one of the key columns (the first indnkeyatts of indkey)
         and not exists (select 1 from pg_attribute a
                         where a.attrelid = c.oid and a.attname = 'org_id'
                           and a.attnum = any ((i.indkey::int2[])[0:i.indnkeyatts - 1]))
         -- a primary key of surrogate columns only (e.g. id uuid default
         -- gen_random_uuid()) is not a natural key that needs org_id
         and not (i.indisprimary
                  and not exists (select 1 from pg_attribute a
                                  where a.attrelid = c.oid
                                    and a.attnum = any ((i.indkey::int2[])[0:i.indnkeyatts - 1])
                                    and not a.atthasdef and a.attidentity = ''))
       order by 1 $$,
    array['push_subscriptions_endpoint_key', 'whatsapp_integrations_phone_number_id_key'],
    'the only unique keys without org_id on org_id tables are the reviewed global ones');

select * from finish();
rollback;
