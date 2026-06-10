-- Security advisor remediation (2 of 3; the 3rd, leaked-password protection,
-- is an Auth dashboard toggle, not SQL).

-- ── Advisor: handle_new_user is an anon/authenticated-executable SECURITY
--    DEFINER function ──────────────────────────────────────────────────────
-- handle_new_user() is the signup TRIGGER on auth.users, NOT a public API.
-- Because it lives in the public schema with EXECUTE granted to PUBLIC, PostgREST
-- exposes it at /rest/v1/rpc/handle_new_user where anon could invoke it. Revoke
-- that exposure. The trigger itself keeps firing on signup — trigger execution
-- does not depend on these role EXECUTE grants.
revoke execute on function public.handle_new_user() from anon, authenticated, public;

-- ── Advisor: documents bucket public listing ──────────────────────────────
-- The bucket was public AND had 4 policies granting the PUBLIC role (incl. anon)
-- full CRUD on its objects — anyone could upload, list, download, or delete KB
-- files. Lock it down to the same shape as the (already-private) proposals
-- bucket: private + authenticated-only. Behaviour-preserving: the app only ever
-- touches this bucket as an authenticated user — browser upload (upload-zone),
-- server-side download for ingestion (/api/ingest, cookie client), and dashboard
-- delete (/api/documents) — never via a public URL (no getPublicUrl anywhere).
update storage.buckets set public = false where id = 'documents';

drop policy if exists "Allow public uploads to documents"     on storage.objects;
drop policy if exists "Allow public downloads from documents"  on storage.objects;
drop policy if exists "Allow public updates to documents"      on storage.objects;
drop policy if exists "Allow public deletions from documents"  on storage.objects;

create policy "documents bucket auth all"
  on storage.objects for all to authenticated
  using (bucket_id = 'documents')
  with check (bucket_id = 'documents');
