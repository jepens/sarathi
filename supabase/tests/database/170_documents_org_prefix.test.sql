-- documents bucket: org folder only, no seed-org fallback (migration 0066;
-- tracker 1.12 / 1.14, audit KEA-4).
--
--   1. catalog: storage.objects has exactly the three org-folder policies, and
--      "documents bucket org members" carries the uuid CASE guard of 0058 in
--      USING and WITH CHECK, with no COALESCE and no seed org uuid;
--   2. behaviour: a seed-org member no longer reaches root-level objects, but
--      reads, updates and deletes its objects under "<seed>/"; a member of
--      another org reaches nothing under "<seed>/"; a non-uuid folder is
--      refused with 42501 (the 0038 policy failed with a uuid cast error);
--   3. 0066's relink and guard, run on fixtures: the relink statement
--      (verbatim from 0066 a) moves only file-backed rows whose copy exists,
--      never editor rows; the three guard predicates (verbatim from 0066 b)
--      find nothing for consistent fixtures and catch each kind of violation.
--      The guard queries are restricted to this file's fixtures, so the test
--      does not assume an empty database. A vitest parity test
--      (scripts/lib/__tests__/migration-0066-parity.test.ts) keeps these copies
--      and the guard's IF condition identical to 0066.
begin;
select plan(49);

select tests.create_two_orgs();
select tests.create_supabase_user('5a11e024-5eed-4000-8000-0000000000aa', 'seed@tes.local',
    jsonb_build_object('org_id', tests.seed_org(), 'org_role', 'owner'));

-- ---------------------------------------------------------------------------
-- 1. Catalog (6)
-- ---------------------------------------------------------------------------
select policies_are('storage', 'objects',
    array['chat-media org members', 'documents bucket org members', 'proposals org members'],
    'storage.objects has exactly the three org-folder policies');

select is(
    (select cmd || ' ' || array_to_string(roles, ',') from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents bucket org members'),
    'ALL authenticated',
    'documents policy: FOR ALL TO authenticated');

select is(
    (select regexp_replace(qual, '\s+', ' ', 'g') from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents bucket org members'),
    $p$((bucket_id = 'documents'::text) AND CASE WHEN ((storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) THEN private.is_org_member(((storage.foldername(name))[1])::uuid) ELSE false END)$p$,
    'documents policy USING: the uuid CASE guard (cast only a well-formed uuid folder, else false)');

select is(
    (select regexp_replace(with_check, '\s+', ' ', 'g') from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents bucket org members'),
    $p$((bucket_id = 'documents'::text) AND CASE WHEN ((storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) THEN private.is_org_member(((storage.foldername(name))[1])::uuid) ELSE false END)$p$,
    'documents policy WITH CHECK: the same uuid CASE guard');

select is(
    (select (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* 'coalesce' from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents bucket org members'),
    false,
    'documents policy: no COALESCE fallback');

select is(
    (select (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%5a11e024-0001-4000-8000-000000000001%'
       from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents bucket org members'),
    false,
    'documents policy: the seed org uuid appears nowhere');

-- ---------------------------------------------------------------------------
-- 2. Behaviour (25)
-- ---------------------------------------------------------------------------
-- A legacy root-level object, its copy under the seed folder (as the script
-- makes it), two more seed objects, one of org A and an org-A key with a '..'
-- segment that names the seed folder further down (its first folder is org A).
insert into storage.objects (bucket_id, name, metadata) values
    ('documents', '1700000000000_legacy root, v1.pdf', '{"size": 10, "mimetype": "application/pdf"}'),
    ('documents', tests.seed_org() || '/1700000000000_legacy root, v1.pdf', '{"size": 10, "mimetype": "application/pdf"}'),
    ('documents', tests.seed_org() || '/x.pdf', null),
    ('documents', tests.seed_org() || '/y.pdf', null),
    ('documents', tests.org_a() || '/a.pdf', null),
    ('documents', tests.org_a() || '/../' || tests.seed_org() || '/titip.pdf', null);

select is(
    (select count(*)::int from storage.objects
      where bucket_id = 'documents' and name = '1700000000000_legacy root, v1.pdf'
        and (storage.foldername(name))[1] is null),
    1, 'precondition: the legacy fixture exists and is root-level for storage.foldername');

-- Member of org A: nothing under the seed folder, no root, no odd folder (10)
select tests.authenticate_as(tests.user_a1());
set local storage.allow_delete_query = 'true';

select is_empty(
    format($$ select 1 from storage.objects where bucket_id = 'documents' and name like %L $$, tests.seed_org() || '/%'),
    'org A member: reads nothing under the seed org folder');
select is_empty(
    format($$ update storage.objects set metadata = '{"x": 1}'::jsonb
              where bucket_id = 'documents' and name = %L returning 1 $$, tests.seed_org() || '/x.pdf'),
    'org A member: updates nothing under the seed org folder');
select is_empty(
    format($$ delete from storage.objects where bucket_id = 'documents' and name = %L returning 1 $$, tests.seed_org() || '/x.pdf'),
    'org A member: deletes nothing under the seed org folder');
select throws_ok(
    format($$ insert into storage.objects (bucket_id, name) values ('documents', %L) $$, tests.seed_org() || '/titipan.pdf'),
    '42501', null,
    'org A member: cannot upload into the seed org folder');
select throws_ok(
    format($$ update storage.objects set name = %L where bucket_id = 'documents' and name = %L $$,
           tests.seed_org() || '/a.pdf', tests.org_a() || '/a.pdf'),
    '42501', null,
    'org A member: cannot move an own object into the seed org folder');
select is_empty(
    $$ select 1 from storage.objects where bucket_id = 'documents' and (storage.foldername(name))[1] is null $$,
    'org A member: reads no root-level object');
select throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('documents', 'bukan-uuid/x.pdf') $$,
    '42501', null,
    'a non-uuid folder is refused with 42501 (0038 failed with a uuid cast error here)');
select throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('documents', '/garis-miring.pdf') $$,
    '42501', null,
    'a name with a leading slash (empty first folder) is refused');
select throws_ok(
    format($$ insert into storage.objects (bucket_id, name) values ('documents', %L) $$,
           upper(tests.seed_org()::text) || '/besar.pdf'),
    '42501', null,
    'org A member: an upper-case seed folder is still the seed org (refused)');
select isnt_empty(
    format($$ select 1 from storage.objects where bucket_id = 'documents' and name = %L $$,
           tests.org_a() || '/../' || tests.seed_org() || '/titip.pdf'),
    'org A member: the org-A key with a ''..'' segment is its own (positive control for the seed check below)');

-- Seed-org member: root-level objects are gone for it too; its folder works (14)
select tests.authenticate_as('5a11e024-5eed-4000-8000-0000000000aa');
set local storage.allow_delete_query = 'true';

select is_empty(
    $$ select 1 from storage.objects where bucket_id = 'documents' and (storage.foldername(name))[1] is null $$,
    'seed member: reads no root-level object (no seed fallback)');
select is_empty(
    $$ update storage.objects set metadata = '{"x": 1}'::jsonb
       where bucket_id = 'documents' and (storage.foldername(name))[1] is null returning 1 $$,
    'seed member: updates no root-level object');
select is_empty(
    $$ delete from storage.objects where bucket_id = 'documents' and (storage.foldername(name))[1] is null returning 1 $$,
    'seed member: deletes no root-level object');
select throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('documents', 'root-baru.pdf') $$,
    '42501', null,
    'seed member: cannot upload a root-level object');
select throws_ok(
    format($$ update storage.objects set name = 'keluar-folder.pdf' where bucket_id = 'documents' and name = %L $$,
           tests.seed_org() || '/y.pdf'),
    '42501', null,
    'seed member: cannot move an object out of its folder to the root');
select isnt_empty(
    format($$ select 1 from storage.objects where bucket_id = 'documents' and name = %L $$,
           tests.seed_org() || '/1700000000000_legacy root, v1.pdf'),
    'seed member: reads the moved copy of a legacy object');
select isnt_empty(
    format($$ select 1 from storage.objects where bucket_id = 'documents' and name = %L $$, tests.seed_org() || '/x.pdf'),
    'seed member: reads <seed>/x');
select isnt_empty(
    format($$ update storage.objects set metadata = '{"x": 1}'::jsonb
              where bucket_id = 'documents' and name = %L returning 1 $$, tests.seed_org() || '/x.pdf'),
    'seed member: updates <seed>/x');
select lives_ok(
    format($$ insert into storage.objects (bucket_id, name) values ('documents', %L) $$, tests.seed_org() || '/baru.txt'),
    'seed member: uploads under the seed org folder');
select isnt_empty(
    format($$ delete from storage.objects where bucket_id = 'documents' and name = %L returning 1 $$, tests.seed_org() || '/x.pdf'),
    'seed member: deletes <seed>/x');
select is_empty(
    format($$ select 1 from storage.objects where bucket_id = 'documents' and name like %L $$, tests.org_a() || '/%'),
    'seed member: reads nothing of org A');
select is_empty(
    format($$ delete from storage.objects where bucket_id = 'documents' and name like %L returning 1 $$, tests.org_a() || '/%'),
    'seed member: deletes nothing of org A');
select lives_ok(
    format($$ insert into storage.objects (bucket_id, name) values ('documents', %L) $$,
           upper(tests.seed_org()::text) || '/besar.pdf'),
    'seed member: an upper-case seed folder is its own org (the same tenant)');
select is_empty(
    format($$ select 1 from storage.objects where bucket_id = 'documents' and name = %L $$,
           tests.org_a() || '/../' || tests.seed_org() || '/titip.pdf'),
    'seed member: an org-A key with a ''..'' segment stays org A''s (first folder decides)');

-- ---------------------------------------------------------------------------
-- 3. 0066 relink and guard on fixtures (18)
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
set local storage.allow_delete_query = 'true';

select is(
    (select count(*)::int from storage.objects
      where bucket_id = 'documents' and name = '1700000000000_legacy root, v1.pdf'),
    1, 'precondition: the root-level object survived every client attempt');

-- documents rows (fixed ids d0..): two file-backed chunks of the legacy object
-- (its copy exists), a file-backed row whose copy does not exist, an editor
-- row titled like the legacy object, an already-prefixed upload of org A.
insert into public.documents (id, org_id, content, metadata) values
    ('d0000000-0000-4000-8000-000000000001', tests.seed_org(), 'x',
     '{"source": "1700000000000_legacy root, v1.pdf", "file_name": "1700000000000_legacy root, v1.pdf", "file_type": "application/pdf", "chunk_index": 0}'),
    ('d0000000-0000-4000-8000-000000000002', tests.seed_org(), 'x',
     '{"source": "1700000000000_legacy root, v1.pdf", "file_name": "1700000000000_legacy root, v1.pdf", "file_type": "application/pdf", "chunk_index": 1}'),
    ('d0000000-0000-4000-8000-000000000003', tests.seed_org(), 'x',
     '{"source": "1700000000001_tanpa salinan.txt", "file_name": "1700000000001_tanpa salinan.txt", "file_type": "text/plain"}'),
    ('d0000000-0000-4000-8000-000000000004', tests.seed_org(), 'x',
     '{"source": "1700000000000_legacy root, v1.pdf", "file_name": "1700000000000_legacy root, v1.pdf", "file_type": "text/markdown", "origin": "editor"}'),
    ('d0000000-0000-4000-8000-000000000005', tests.org_a(), 'x',
     jsonb_build_object('source', tests.org_a() || '/a.pdf', 'file_name', 'a.pdf'));
create temp table t170_before on commit drop as
    select id, metadata from public.documents where id::text like 'd0000000-0000-4000-8000-%';

-- 0066 (a), verbatim.
update public.documents d
   set metadata = jsonb_set(d.metadata, '{source}', to_jsonb(d.org_id::text || '/' || (d.metadata->>'source')))
 where coalesce(d.metadata->>'origin', '') <> 'editor'
   and d.metadata ? 'source'
   and strpos(d.metadata->>'source', '/') = 0
   and exists (
       select 1
         from storage.objects o
        where o.bucket_id = 'documents'
          and o.name = d.org_id::text || '/' || (d.metadata->>'source')
   );

select results_eq(
    $$ select metadata->>'source' from public.documents
       where id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002') order by id $$,
    $$ values (tests.seed_org() || '/1700000000000_legacy root, v1.pdf'),
              (tests.seed_org() || '/1700000000000_legacy root, v1.pdf') $$,
    'relink: the file-backed rows now name the copy under their org folder');
select results_eq(
    $$ select metadata->>'file_name' from public.documents
       where id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002') order by id $$,
    $$ values ('1700000000000_legacy root, v1.pdf'), ('1700000000000_legacy root, v1.pdf') $$,
    'relink: file_name is unchanged (the KB list and RAG citations look the same)');
select is(
    (select metadata->>'source' from public.documents where id = 'd0000000-0000-4000-8000-000000000003'),
    '1700000000001_tanpa salinan.txt',
    'relink: a row whose copy does not exist is left alone');
select is(
    (select metadata->>'source' from public.documents where id = 'd0000000-0000-4000-8000-000000000004'),
    '1700000000000_legacy root, v1.pdf',
    'relink: an editor row is never relinked, even when a copy of that name exists');
select is(
    (select metadata->>'source' from public.documents where id = 'd0000000-0000-4000-8000-000000000005'),
    tests.org_a() || '/a.pdf',
    'relink: an already-prefixed row is left alone');
select is(
    (select count(*)::int from public.documents d join t170_before b using (id)
      where (d.metadata - 'source') is distinct from (b.metadata - 'source')),
    0,
    'relink: no other metadata key changed');

-- Guard predicate 1 (0066 b, verbatim): file-backed rows outside their org folder.
select results_eq(
    $$ select d.id::text from public.documents d
        where coalesce(d.metadata->>'origin', '') <> 'editor'
          and d.metadata ? 'source'
          and not starts_with(coalesce(d.metadata->>'source', ''), d.org_id::text || '/')
          and d.id::text like 'd0000000-0000-4000-8000-%' $$,
    $$ values ('d0000000-0000-4000-8000-000000000003') $$,
    'guard 1: catches the file-backed row that could not be relinked (and not the editor row)');
delete from public.documents where id = 'd0000000-0000-4000-8000-000000000003';
select is_empty(
    $$ select d.id from public.documents d
        where coalesce(d.metadata->>'origin', '') <> 'editor'
          and d.metadata ? 'source'
          and not starts_with(coalesce(d.metadata->>'source', ''), d.org_id::text || '/')
          and d.id::text like 'd0000000-0000-4000-8000-%' $$,
    'guard 1: passes once every file-backed row is inside its org folder');
insert into public.documents (id, org_id, content, metadata) values
    ('d0000000-0000-4000-8000-000000000006', tests.seed_org(), 'x', '{"source": null}'),
    ('d0000000-0000-4000-8000-000000000007', tests.seed_org(), 'x', jsonb_build_object('source', tests.org_a() || '/salah-org.pdf'));
select results_eq(
    $$ select d.id::text from public.documents d
        where coalesce(d.metadata->>'origin', '') <> 'editor'
          and d.metadata ? 'source'
          and not starts_with(coalesce(d.metadata->>'source', ''), d.org_id::text || '/')
          and d.id::text like 'd0000000-0000-4000-8000-%' order by 1 $$,
    $$ values ('d0000000-0000-4000-8000-000000000006'), ('d0000000-0000-4000-8000-000000000007') $$,
    'guard 1: also catches a null source and a source in another org''s folder');
delete from public.documents where id in ('d0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000007');

-- Guard predicate 2 (0066 b, verbatim): root-level objects without a same-size
-- copy under the seed org folder.
select is_empty(
    $$ select o.name from storage.objects o
        where o.bucket_id = 'documents'
          and (storage.foldername(o.name))[1] is null
          and not exists (
              select 1 from storage.objects c
               where c.bucket_id = 'documents'
                 and c.name = '5a11e024-0001-4000-8000-000000000001/' || o.name
                 and c.metadata->>'size' = o.metadata->>'size')
          and o.name like '1700000000%' $$,
    'guard 2: passes when every root-level object has a same-size copy');
insert into storage.objects (bucket_id, name, metadata) values
    ('documents', '1700000000001_tanpa salinan.txt', '{"size": 5}'),
    ('documents', '1700000000002_salinan beda.txt', '{"size": 7}'),
    ('documents', tests.seed_org() || '/1700000000002_salinan beda.txt', '{"size": 6}');
select results_eq(
    $$ select o.name from storage.objects o
        where o.bucket_id = 'documents'
          and (storage.foldername(o.name))[1] is null
          and not exists (
              select 1 from storage.objects c
               where c.bucket_id = 'documents'
                 and c.name = '5a11e024-0001-4000-8000-000000000001/' || o.name
                 and c.metadata->>'size' = o.metadata->>'size')
          and o.name like '1700000000%' order by 1 $$,
    $$ values ('1700000000001_tanpa salinan.txt'), ('1700000000002_salinan beda.txt') $$,
    'guard 2: catches a root-level object without a copy and one whose copy has another size');
delete from storage.objects where bucket_id = 'documents'
   and name in ('1700000000001_tanpa salinan.txt', '1700000000002_salinan beda.txt',
                tests.seed_org() || '/1700000000002_salinan beda.txt');

-- Guard predicate 3 (0066 b, verbatim): objects in a non-uuid first folder.
select is_empty(
    $$ select o.name from storage.objects o
        where o.bucket_id = 'documents'
          and (storage.foldername(o.name))[1] is not null
          and (storage.foldername(o.name))[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and (o.name like '%1700000000%' or o.name like 'bukan-uuid/%' or o.name like '/%') $$,
    'guard 3: passes when every folder is a uuid');
insert into storage.objects (bucket_id, name) values
    ('documents', 'bukan-uuid/1700000000003.pdf'),
    ('documents', '/1700000000004.pdf');
select results_eq(
    $$ select o.name from storage.objects o
        where o.bucket_id = 'documents'
          and (storage.foldername(o.name))[1] is not null
          and (storage.foldername(o.name))[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and (o.name like '%1700000000%' or o.name like 'bukan-uuid/%' or o.name like '/%') order by 1 $$,
    $$ values ('/1700000000004.pdf'), ('bukan-uuid/1700000000003.pdf') $$,
    'guard 3: catches a non-uuid folder and an empty first folder (leading slash)');
delete from storage.objects where bucket_id = 'documents'
   and name in ('bukan-uuid/1700000000003.pdf', '/1700000000004.pdf');

-- The relink is idempotent: a second run changes nothing.
select is_empty(
    $$ update public.documents d
          set metadata = jsonb_set(d.metadata, '{source}', to_jsonb(d.org_id::text || '/' || (d.metadata->>'source')))
        where coalesce(d.metadata->>'origin', '') <> 'editor'
          and d.metadata ? 'source'
          and strpos(d.metadata->>'source', '/') = 0
          and exists (
              select 1
                from storage.objects o
               where o.bucket_id = 'documents'
                 and o.name = d.org_id::text || '/' || (d.metadata->>'source')
          )
          and d.id::text like 'd0000000-0000-4000-8000-%'
       returning d.id $$,
    'relink: a second run touches no row');

-- The root-level object itself is still there: 0066 never touches
-- storage.objects (the script deletes originals through the Storage API).
select is(
    (select count(*)::int from storage.objects
      where bucket_id = 'documents' and name = '1700000000000_legacy root, v1.pdf'),
    1, 'the relink and guard leave storage.objects untouched');

-- Seed member after the relink: the KB row's object is reachable, the
-- original is not (what DELETE /api/documents relies on).
select tests.authenticate_as('5a11e024-5eed-4000-8000-0000000000aa');
select isnt_empty(
    $$ select 1 from storage.objects o
        join public.documents d on o.bucket_id = 'documents' and o.name = d.metadata->>'source'
       where d.id = 'd0000000-0000-4000-8000-000000000001' $$,
    'seed member: the object a relinked row names is reachable');
select is_empty(
    $$ select 1 from storage.objects o
        where o.bucket_id = 'documents' and o.name = '1700000000000_legacy root, v1.pdf' $$,
    'seed member: its old root-level name is not');

select * from finish();
rollback;
