-- Private storage bucket for uploaded proposal PDFs.
-- File path convention: {phone_number}/{uuid}.pdf
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'proposals',
    'proposals',
    false,
    10485760,  -- 10 MB per file
    array['application/pdf']
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- RLS for the proposals bucket: only authenticated dashboard users can
-- INSERT, SELECT (download), or DELETE. This relies on bucket_id matching
-- so we don't accidentally widen access to other buckets.
do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage' and tablename = 'objects' and policyname = 'proposals bucket auth all'
    ) then
        create policy "proposals bucket auth all" on storage.objects
            for all to authenticated
            using (bucket_id = 'proposals')
            with check (bucket_id = 'proposals');
    end if;
end $$;
