-- Storage policies per org prefix (tracker 1.2 / 1.14, audit KUA-13 / KEA-4).
--
-- Objects live under "<org_id>/..." in the chat-media, proposals and documents
-- buckets; only members of that org may read or write them. These tests run
-- the storage.objects RLS policies directly (the Storage API evaluates the same
-- policies as the caller's role). Direct DELETEs on storage tables are blocked
-- by a storage trigger unless storage.allow_delete_query is set, so the delete
-- checks set it (it only lifts that guard, not RLS).
--
-- Known gaps tracked elsewhere, recorded as TODO tests (they report "not ok #
-- TODO" without failing the run and start passing once fixed):
--   * 1.11: chat-media is still a PUBLIC bucket — public URLs bypass RLS.
--   * 1.12: documents objects without an "<org_id>/" folder fall back to the
--           seed org (COALESCE in the 0038 policy).
begin;
select plan(44);

select tests.create_two_orgs();

-- A seed-org (Sailendra) member, provisioned like every other user.
select tests.create_supabase_user('5a11e024-5eed-4000-8000-0000000000aa', 'seed@tes.local',
    jsonb_build_object('org_id', tests.seed_org(), 'org_role', 'owner'));

insert into storage.objects (bucket_id, name) values
    ('chat-media', tests.org_a() || '/fixture.jpg'),
    ('chat-media', tests.org_b() || '/fixture.jpg'),
    ('proposals',  tests.org_a() || '/fixture.pdf'),
    ('proposals',  tests.org_b() || '/fixture.pdf'),
    ('documents',  tests.org_a() || '/fixture.pdf'),
    ('documents',  tests.org_b() || '/fixture.pdf'),
    ('documents',  'legacy-root.pdf');

-- ---------------------------------------------------------------------------
-- Member of org A: own prefix only, in every bucket (3 x 8)
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_a1());
set local storage.allow_delete_query = 'true';

select lives_ok(
    format($$ insert into storage.objects (bucket_id, name) values (%L, %L) $$, b, tests.org_a() || '/baru.bin'),
    b || ': a member uploads under their own org prefix')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select throws_ok(
    format($$ insert into storage.objects (bucket_id, name) values (%L, %L) $$, b, tests.org_b() || '/baru.bin'),
    '42501', null,
    b || ': a member cannot upload under another org''s prefix')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select isnt_empty(
    format($$ select 1 from storage.objects where bucket_id = %L and name like %L $$, b, tests.org_a() || '/%'),
    b || ': a member lists their own org''s objects')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select is_empty(
    format($$ select 1 from storage.objects where bucket_id = %L and name not like %L $$, b, tests.org_a() || '/%'),
    b || ': a member sees no object outside their org prefix')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select is_empty(
    format($$ update storage.objects set metadata = '{"x": 1}'::jsonb
              where bucket_id = %L and name like %L returning 1 $$, b, tests.org_b() || '/%'),
    b || ': a member updates no object of another org')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select throws_ok(
    format($$ update storage.objects set name = %L where bucket_id = %L and name = %L $$,
           tests.org_b() || '/dipindah.bin', b, tests.org_a() || '/baru.bin'),
    '42501', null,
    b || ': a member cannot move an object into another org''s prefix')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select is_empty(
    format($$ delete from storage.objects where bucket_id = %L and name like %L returning 1 $$, b, tests.org_b() || '/%'),
    b || ': a member deletes no object of another org')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select isnt_empty(
    format($$ delete from storage.objects where bucket_id = %L and name = %L returning 1 $$, b, tests.org_a() || '/baru.bin'),
    b || ': a member deletes their own object')
from unnest(array['chat-media', 'proposals', 'documents']) b;

-- Paths without a well-formed org folder are refused (chat-media, proposals).
select throws_ok(
    format($$ insert into storage.objects (bucket_id, name) values (%L, %L) $$, b, p),
    '42501', null,
    format('%s: an object at %s (no org folder) is refused', b, p))
from unnest(array['chat-media', 'proposals']) b,
     unnest(array['root.bin', 'bukan-uuid/x.bin']) p;

-- documents: root objects resolve to the seed org, so a tenant member is
-- refused there; a non-uuid folder errors out (cast) instead of being denied.
select throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('documents', 'root-baru.pdf') $$,
    '42501', null,
    'documents: a tenant member cannot upload a root-level (legacy) object');
select is_empty(
    $$ select 1 from storage.objects where bucket_id = 'documents' and name = 'legacy-root.pdf' $$,
    'documents: a tenant member cannot read legacy root-level objects');
select throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('documents', 'bukan-uuid/x.pdf') $$,
    null, null,
    'documents: a non-uuid folder is refused');

-- ---------------------------------------------------------------------------
-- Member of org B: blind to org A's objects (3)
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_b1());
select is_empty(
    format($$ select 1 from storage.objects where bucket_id = %L and name like %L $$, b, tests.org_a() || '/%'),
    b || ': the other org sees none of org A''s objects')
from unnest(array['chat-media', 'proposals', 'documents']) b;

-- ---------------------------------------------------------------------------
-- anon: nothing through the API roles (3 x 2)
-- ---------------------------------------------------------------------------
select tests.authenticate_as_anon();
select is_empty(
    format($$ select 1 from storage.objects where bucket_id = %L $$, b),
    b || ': anon lists no object')
from unnest(array['chat-media', 'proposals', 'documents']) b;
select throws_ok(
    format($$ insert into storage.objects (bucket_id, name) values (%L, %L) $$, b, tests.org_a() || '/anon.bin'),
    '42501', null,
    b || ': anon cannot upload')
from unnest(array['chat-media', 'proposals', 'documents']) b;

-- ---------------------------------------------------------------------------
-- Seed org (tenant #1) keeps its behaviour (1)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('5a11e024-5eed-4000-8000-0000000000aa');
select isnt_empty(
    $$ select 1 from storage.objects where bucket_id = 'documents' and name = 'legacy-root.pdf' $$,
    'documents: seed-org members still reach legacy root-level KB files');

-- ---------------------------------------------------------------------------
-- Org B's objects survived every attempt (1) + known gaps as TODO (2)
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
select is(
    (select count(*)::int from storage.objects
      where name like tests.org_b() || '/%' and metadata is null),
    3, 'org B''s objects are intact and unchanged');

select todo('tracker 1.11: chat-media is still a public bucket (public URLs bypass RLS)', 1);
select is(
    (select public from storage.buckets where id = 'chat-media'),
    false, 'chat-media bucket is private');

select todo('tracker 1.12: documents policy still falls back to the seed org for root objects', 1);
select is_empty(
    $$ select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and coalesce(qual, '') like '%5a11e024-0001-4000-8000-000000000001%' $$,
    'no storage policy falls back to the seed org');

select * from finish();
rollback;
