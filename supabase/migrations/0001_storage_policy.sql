-- Allow public access to the 'documents' bucket
-- This is required because Supabase Storage has RLS enabled by default.

-- 1. Allow uploads (INSERT)
create policy "Allow public uploads to documents"
on storage.objects
for insert
to public
with check ( bucket_id = 'documents' );

-- 2. Allow downloads/viewing (SELECT)
create policy "Allow public downloads from documents"
on storage.objects
for select
to public
using ( bucket_id = 'documents' );

-- 3. Allow updates (UPDATE)
create policy "Allow public updates to documents"
on storage.objects
for update
to public
using ( bucket_id = 'documents' );

-- 4. Allow deletions (DELETE)
create policy "Allow public deletions from documents"
on storage.objects
for delete
to public
using ( bucket_id = 'documents' );
