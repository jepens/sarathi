-- chat-media bucket: private, 50 MiB, WhatsApp type allowlist (migration
-- 0067; tracker 1.11 / 1.14, audit KEA-4, owner decisions D18 / D20).
--
--   1. the bucket row: it exists once, public = false, file_size_limit =
--      52428800 (50 MiB, D20) and allowed_mime_types is exactly the 19 types
--      of 0067, in order (lib/storage/chat-media.ts CHAT_MEDIA_ALLOWED_MIME; a
--      vitest keeps the two lists identical);
--   2. the allowlist: 19 distinct lower-case type/subtype entries (no
--      parameters, no wildcard), none a browser runs as script or renders as
--      an active document (html, svg, xml, javascript; text/plain is the only
--      text type);
--   3. reading is RLS-only now: "chat-media org members" (0058) is the only
--      storage policy that names the bucket, for authenticated only. A member's
--      own read of the object row is what createSignedUrl checks for
--      /api/chat-media/[id]: members of the object's org (owner and staff) can
--      sign it, a member of another org and anon cannot.
-- The Storage API enforces the rest (the public URL refused, an upload above
-- the limit or of another type refused); CI runs Postgres only, so the PR
-- checks that end to end on a local `supabase start` stack. The RLS matrix
-- and the anon checks of all three buckets stay in 040_storage.test.sql.
begin;
select plan(12);

select tests.create_two_orgs();

-- ---------------------------------------------------------------------------
-- 1. The bucket row (4)
-- ---------------------------------------------------------------------------
select is(
    (select count(*)::int from storage.buckets where id = 'chat-media'),
    1, 'precondition: the chat-media bucket exists');

select is(
    (select public from storage.buckets where id = 'chat-media'),
    false, 'chat-media is private: no public URL bypasses the storage policy');

select is(
    (select file_size_limit from storage.buckets where id = 'chat-media'),
    52428800::bigint, 'chat-media file_size_limit is 50 MiB (52428800, D20)');

select is(
    (select allowed_mime_types from storage.buckets where id = 'chat-media'),
    array[
        'image/jpeg',
        'image/png',
        'image/webp',
        'audio/aac',
        'audio/amr',
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
        'video/mp4',
        'video/3gpp',
        'application/pdf',
        'text/plain',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/octet-stream'
    ]::text[],
    'chat-media allowed_mime_types is exactly the 19 types of 0067, in order');

-- ---------------------------------------------------------------------------
-- 2. The allowlist itself (2); both fail on a NULL list (ok(NULL) fails)
-- ---------------------------------------------------------------------------
select ok(
    (select cardinality(b.allowed_mime_types) = 19
            and (select count(distinct t) from unnest(b.allowed_mime_types) t) = 19
            and (select bool_and(t ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$')
                   from unnest(b.allowed_mime_types) t)
       from storage.buckets b
      where b.id = 'chat-media'),
    'the allowlist holds 19 distinct lower-case type/subtype entries (no parameters, no wildcard)');

-- xml only as the subtype or the +xml suffix: the OOXML document types
-- (application/vnd.openxmlformats-...) are allowed on purpose.
select ok(
    (select b.allowed_mime_types is not null
            and not exists (
                select 1 from unnest(b.allowed_mime_types) t
                 where t ~ '(html|svg|javascript|ecmascript|[/+]xml$)'
                    or (t like 'text/%' and t <> 'text/plain'))
       from storage.buckets b
      where b.id = 'chat-media'),
    'the allowlist has no active type (html, svg, xml, javascript; text/plain is the only text type)');

-- ---------------------------------------------------------------------------
-- 3. Reading is RLS-only now (6)
-- ---------------------------------------------------------------------------
-- policyname and roles are of type name (collation "C"): compare as default text.
select results_eq(
    $$ select policyname::text collate "default", cmd, array_to_string(roles, ',') collate "default"
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%chat-media%' $$,
    $$ values ('chat-media org members', 'ALL', 'authenticated') $$,
    'only "chat-media org members" (FOR ALL TO authenticated) names the bucket: no anon or public read policy');

-- An object as the writers key it: <org>/<safe phone>/<uuid>.<ext> (fake values).
insert into storage.objects (bucket_id, name) values
    ('chat-media', tests.org_a() || '/620000000000/5e1f0000-0000-4000-8000-000000000001.jpg');

select is(
    (select count(*)::int from storage.objects
      where bucket_id = 'chat-media'
        and name = tests.org_a() || '/620000000000/5e1f0000-0000-4000-8000-000000000001.jpg'),
    1, 'precondition: the org A object exists');

select tests.authenticate_as(tests.user_a1());
select isnt_empty(
    format($$ select 1 from storage.objects where bucket_id = 'chat-media' and name = %L $$,
           tests.org_a() || '/620000000000/5e1f0000-0000-4000-8000-000000000001.jpg'),
    'org A owner reads the object row, so /api/chat-media can sign it in that session');

select tests.authenticate_as(tests.user_a2());
select isnt_empty(
    format($$ select 1 from storage.objects where bucket_id = 'chat-media' and name = %L $$,
           tests.org_a() || '/620000000000/5e1f0000-0000-4000-8000-000000000001.jpg'),
    'org A staff reads it too (every member of the org sees the chat media)');

select tests.authenticate_as(tests.user_b1());
select is_empty(
    format($$ select 1 from storage.objects where bucket_id = 'chat-media' and name = %L $$,
           tests.org_a() || '/620000000000/5e1f0000-0000-4000-8000-000000000001.jpg'),
    'a member of org B reads nothing, so it cannot sign org A''s object');

select tests.authenticate_as_anon();
select is_empty(
    format($$ select 1 from storage.objects where bucket_id = 'chat-media' and name = %L $$,
           tests.org_a() || '/620000000000/5e1f0000-0000-4000-8000-000000000001.jpg'),
    'anon reads nothing: without a public URL only a member JWT or a signed URL reaches the object');

select * from finish();
rollback;
