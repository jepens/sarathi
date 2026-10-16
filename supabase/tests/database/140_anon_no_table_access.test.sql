-- anon holds no table privilege in schema public (migration 0063; tracker 1.9
-- step 0 / 1.14, audit KEA-15 / KUA-13).
--
-- realtime.apply_rls sends DELETE events without an RLS check, with the
-- primary-key columns the subscriber's role may SELECT, so for the published
-- tables the privilege, not RLS, is what keeps the anon key out:
--   1. default privileges: a table (with an identity sequence) that postgres
--      creates in public gives anon nothing, while authenticated and
--      service_role keep the platform's automatic grants;
--   2. the app roles keep their grants on the existing tables (only anon was
--      revoked);
--   3. anon is refused (42501) on the 4 tables the supabase_realtime
--      publication carried until 0068 and may SELECT no column of a table
--      it publishes (none since 0068; 070 guard 10).
-- 070 guard 11 checks every relation in public; this file checks the
-- mechanism behind it.
begin;
select plan(55);

-- ---------------------------------------------------------------------------
-- 1. Default privileges of postgres in public (0063 step 2)
-- ---------------------------------------------------------------------------
select is_empty(
    $$ select d.defaclobjtype::text from pg_default_acl d, aclexplode(d.defaclacl) a
       where d.defaclrole = 'postgres'::regrole
         and d.defaclnamespace in (0, 'public'::regnamespace)
         and d.defaclobjtype in ('r', 'S')
         and a.grantee = 'anon'::regrole $$,
    'the default privileges of postgres grant anon nothing on new tables or sequences in public');

-- Created inside this transaction (rolled back at the end).
create table public.tst_anon_default_acl (
    id bigint generated always as identity primary key,
    note text
);

select is((select pg_get_userbyid(relowner) from pg_class where oid = 'public.tst_anon_default_acl'::regclass),
          'postgres',
          'precondition: the new table is owned by postgres (whose default privileges 0063 changed)');

select is(has_table_privilege('anon', 'public.tst_anon_default_acl', p), false,
          format('new table: anon has no %s privilege', p))
from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                  'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p;

select is(has_sequence_privilege('anon', pg_get_serial_sequence('public.tst_anon_default_acl', 'id'), p), false,
          format('new identity sequence: anon has no %s privilege', p))
from unnest(array['USAGE', 'SELECT', 'UPDATE']) p;

select is(has_table_privilege(r, 'public.tst_anon_default_acl', p), true,
          format('new table: %s keeps %s', r, p))
from unnest(array['authenticated', 'service_role']) r,
     unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;

select is(has_sequence_privilege(r, pg_get_serial_sequence('public.tst_anon_default_acl', 'id'), 'USAGE'), true,
          format('new identity sequence: %s keeps USAGE', r))
from unnest(array['authenticated', 'service_role']) r;

select tests.authenticate_as_anon();
select throws_ok(
    $$ select 1 from public.tst_anon_default_acl $$,
    '42501', 'permission denied for table tst_anon_default_acl',
    'new table: anon cannot read it');

select tests.authenticate_as(tests.user_a1());
select lives_ok(
    $$ insert into public.tst_anon_default_acl (note) values ('tst') $$,
    'new table: authenticated can write it with the automatic grant');

select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- 2. The app roles keep their grants on the existing tables
-- ---------------------------------------------------------------------------
select is(has_table_privilege('authenticated', format('public.%I', t), p), true,
          format('%s: authenticated keeps %s', t, p))
from unnest(array['whatsapp_chats', 'whatsapp_messages', 'labels', 'chat_labels',
                  'orders', 'documents']) t,
     unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;

select is_empty(
    $$ select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and not (has_table_privilege('service_role', c.oid, 'SELECT')
                  and has_table_privilege('service_role', c.oid, 'INSERT')
                  and has_table_privilege('service_role', c.oid, 'UPDATE')
                  and has_table_privilege('service_role', c.oid, 'DELETE')) $$,
    'service_role keeps SELECT/INSERT/UPDATE/DELETE on every public table');

-- ---------------------------------------------------------------------------
-- 3. anon and the supabase_realtime tables
-- ---------------------------------------------------------------------------
-- What realtime.apply_rls (DELETE old_record) and
-- realtime.subscription_check_filters (filter columns) read.
select is_empty(
    $$ select pt.schemaname || '.' || pt.tablename || '.' || a.attname
       from pg_publication_tables pt
       join pg_attribute a
         on a.attrelid = format('%I.%I', pt.schemaname, pt.tablename)::regclass
        and a.attnum > 0 and not a.attisdropped
       where pt.pubname = 'supabase_realtime'
         and has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT') $$,
    'anon may SELECT no column of a realtime-published table');

select tests.authenticate_as_anon();
select throws_ok(
    format('select 1 from public.%I', t),
    '42501', format('permission denied for table %s', t),
    format('%s (published until 0068): anon cannot read it', t))
from unnest(array['whatsapp_chats', 'whatsapp_messages', 'labels', 'chat_labels']) t;

select * from finish();
rollback;
