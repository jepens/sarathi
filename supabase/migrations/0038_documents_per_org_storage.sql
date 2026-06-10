-- Per-org isolation for the KB documents bucket + kb_sources editor table.

-- 1) documents bucket: replace the blanket authenticated policy (any signed-in
--    user could touch any object) with an org-path-scoped one. New objects are
--    stored under "<org_id>/<file>"; the policy authorises only members of that
--    org. Legacy objects (no "<org_id>/" prefix) have no folder segment, so they
--    fall back to the seed org (Sailendra) — preserving access for the only
--    existing tenant. Validated as the Sailendra user: legacy + own-org allowed,
--    other-org denied. Safe with currently-deployed code, which still uploads
--    unprefixed paths (they hit the Sailendra fallback, and current users are
--    Sailendra members).
drop policy if exists "documents bucket auth all" on storage.objects;
create policy "documents bucket org members"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'documents'
    and private.is_org_member(
      coalesce((storage.foldername(name))[1], '5a11e024-0001-4000-8000-000000000001')::uuid
    )
  )
  with check (
    bucket_id = 'documents'
    and private.is_org_member(
      coalesce((storage.foldername(name))[1], '5a11e024-0001-4000-8000-000000000001')::uuid
    )
  );

-- 2) kb_sources: title was globally UNIQUE, so two orgs couldn't have a
--    same-titled source and the editor-save onConflict was 'title'. Add a
--    per-org composite unique so the editor can upsert scoped to (org_id, title).
--    Additive: the global UNIQUE(title) is kept for now (old code keeps working);
--    drop it in a later contract step once a second tenant needs a duplicate
--    title.
alter table public.kb_sources
  add constraint kb_sources_org_title_key unique (org_id, title);
