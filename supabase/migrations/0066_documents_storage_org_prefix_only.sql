-- Fase 1 — bucket documents: org folder only, no seed-org fallback (tracker
-- 1.12 / 1.14; audit KEA-4; owner decisions D16, D17).
--
-- Why. The 0038 policy "documents bucket org members" resolves an object
-- without a folder (a root-level name) to the seed org:
-- is_org_member(COALESCE((storage.foldername(name))[1], '<seed org>')::uuid).
-- So every seed-org member reads, overwrites and deletes root-level objects
-- and may create new ones there, the KB of tenant #1 rests on an implicit
-- fallback instead of its folder, and an object in a folder that is not a
-- uuid makes the policy itself fail with a cast error (22P02) for every
-- caller instead of a plain denial. All code writes "<org_id>/<ts>_<name>"
-- since 86b3872 (upload-zone, /api/ingest, DELETE /api/documents), but
-- production still holds the legacy objects of the single-tenant era.
-- Read-only production check 2026-10-16: 15 objects in documents, all at the
-- root, 0 in any folder; 8 file-backed documents rows of the seed org name 2
-- of them in metadata.source, the other 13 objects are referenced by nothing;
-- the 7 editor rows have no object (source = title).
--
--   a. relink: every file-backed documents row (origin <> 'editor', with a
--      source key) whose source is a root-level name gets
--      source = '<its org_id>/<name>', but only where that copy exists. The
--      copies are made beforehand by scripts/migrate-legacy-kb-objects.mjs
--      (Storage API, sha256-verified). file_name is unchanged, so the
--      dashboard KB list and the RAG citations look the same.
--   b. guard: refuse to run (the DO block raises, so the whole migration,
--      including the relink, rolls back) if afterwards
--        - a file-backed row with a source is outside its org folder,
--        - a root-level object has no copy of the same size at
--          '<seed org>/<same name>', or
--        - an object sits in a first folder that is not a uuid.
--   c. policy: "documents bucket org members" is recreated with the CASE
--      guard of 0058 (chat-media, proposals) in USING and WITH CHECK: only a
--      well-formed uuid first folder is cast and checked with
--      is_org_member(); a root-level name or any other folder is denied
--      (42501), never a cast error and never the seed org.
-- (a) and (c) ship together on purpose: DELETE /api/documents removes the
-- object named in metadata.source through the user's RLS client, which after
-- (c) reaches only "<org_id>/..." keys; a row left pointing at a root-level
-- name would leave its file behind when the KB entry is deleted.
--
-- Deploy order: independent of the app deploy (no code change). Run it ONLY
-- after the script's copy and verify phases have passed against the same
-- project (runbook: docs/RUNBOOK_LEGACY_KB_OBJECTS.md, steps 0-9); the guard
-- refuses otherwise. A KB freeze for the seed org (no KB upload or delete)
-- runs from the copy phase until the checks after this migration: a KB
-- delete in between would remove the original through the 0038 policy and
-- leave its copy behind. Apply with apply_migration from the LF git blob of
-- this file. On a fresh replay (no legacy objects, no rows) (a) and (b) are
-- no-ops and only the policy changes.
--
-- Never rename or move storage objects with SQL. storage.objects is the
-- Storage API's metadata: postgres has BYPASSRLS and UPDATE on it and no
-- trigger stops an UPDATE of name, so the row would "move" while the bytes
-- stay under the old key. Copies and deletes go through the Storage API (the
-- script); this migration only reads storage.objects.
--
-- Rollback, by stage (row ids from the script's manifest.json in its --out):
--   * after the copy phase, before this migration: remove the copies through
--     the Storage API; nothing else changed.
--   * after this migration, before delete-originals (the 72 h soak): a
--     follow-up migration that recreates the 0038 policy text
--       drop policy if exists "documents bucket org members" on storage.objects;
--       create policy "documents bucket org members" on storage.objects
--         for all to authenticated
--         using (bucket_id = 'documents' and private.is_org_member(
--             coalesce((storage.foldername(name))[1], '5a11e024-0001-4000-8000-000000000001')::uuid))
--         with check (bucket_id = 'documents' and private.is_org_member(
--             coalesce((storage.foldername(name))[1], '5a11e024-0001-4000-8000-000000000001')::uuid));
--     and reverts only the relinked rows (not later uploads):
--       update public.documents
--          set metadata = jsonb_set(metadata, '{source}', to_jsonb(substr(metadata->>'source', 38)))
--        where id = any (array[<the row ids of the manifest>]::uuid[]);
--     then remove the copies through the Storage API.
--   * after delete-originals: first --phase=restore --confirm (originals back
--     from the copies, else from the byte backup), then as above.
--   The 0038 fallback only ever reaches the seed org, so this rollback opens
--   nothing to another tenant.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

-- ---------------------------------------------------------------------------
-- a. relink file-backed rows to their copy under the row's org folder
-- ---------------------------------------------------------------------------
-- Every column is qualified: storage.objects has its own metadata and name.
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

-- ---------------------------------------------------------------------------
-- b. guard: nothing may still depend on the seed-org fallback
-- ---------------------------------------------------------------------------
-- The same predicates are exercised in 170_documents_org_prefix.test.sql;
-- keep them in sync.
do $$
declare
    v_rows_outside   bigint;
    v_missing_copies bigint;
    v_bad_folders    bigint;
begin
    select count(*) into v_rows_outside
      from public.documents d
     where coalesce(d.metadata->>'origin', '') <> 'editor'
       and d.metadata ? 'source'
       and not starts_with(coalesce(d.metadata->>'source', ''), d.org_id::text || '/');

    select count(*) into v_missing_copies
      from storage.objects o
     where o.bucket_id = 'documents'
       and (storage.foldername(o.name))[1] is null
       and not exists (
           select 1
             from storage.objects c
            where c.bucket_id = 'documents'
              and c.name = '5a11e024-0001-4000-8000-000000000001/' || o.name
              and c.metadata->>'size' = o.metadata->>'size'
       );

    select count(*) into v_bad_folders
      from storage.objects o
     where o.bucket_id = 'documents'
       and (storage.foldername(o.name))[1] is not null
       and (storage.foldername(o.name))[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    if v_rows_outside > 0 or v_missing_copies > 0 or v_bad_folders > 0 then
        raise exception '0066 refused: % file-backed documents row(s) outside their org folder, % root-level object(s) without a same-size copy under the seed org folder, % object(s) in a non-uuid folder',
            v_rows_outside, v_missing_copies, v_bad_folders
            using hint = 'Run scripts/migrate-legacy-kb-objects.mjs --phase=copy --confirm and --phase=verify first (docs/RUNBOOK_LEGACY_KB_OBJECTS.md).';
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- c. documents policy: org folder only (CASE guard of 0058)
-- ---------------------------------------------------------------------------
drop policy if exists "documents bucket org members" on storage.objects;
create policy "documents bucket org members" on storage.objects
    for all to authenticated
    using (
        bucket_id = 'documents'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then private.is_org_member(((storage.foldername(name))[1])::uuid)
            else false
        end
    )
    with check (
        bucket_id = 'documents'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then private.is_org_member(((storage.foldername(name))[1])::uuid)
            else false
        end
    );
