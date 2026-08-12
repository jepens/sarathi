-- Admin-sent media (photos / documents) in the chat window. Adds media columns to
-- whatsapp_messages and a storage bucket to hold the files so the dashboard can
-- render them inline — Meta keeps its own copy only ~30 days and it isn't directly
-- displayable. Send-only for now; inbound (customer) media is a later feature.

alter table public.whatsapp_messages
    add column if not exists media_type     text
        check (media_type is null or media_type in ('image', 'document')),
    add column if not exists media_url      text,
    add column if not exists media_mime     text,
    add column if not exists media_filename text;

-- Public bucket: the files are admin-sent content already delivered to the
-- customer over WhatsApp (not secret) and the paths are unguessable UUIDs, so a
-- public bucket keeps inline <img>/<a> display simple (no signed-URL expiry churn).
insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', true)
on conflict (id) do nothing;

-- Authenticated dashboard users may upload/manage chat media (scoped to the
-- bucket); public read happens through the bucket's public URL, no policy needed.
do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'chat-media auth manage'
    ) then
        create policy "chat-media auth manage" on storage.objects
            for all to authenticated
            using (bucket_id = 'chat-media')
            with check (bucket_id = 'chat-media');
    end if;
end $$;
