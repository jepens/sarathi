-- Fase 1 — chat-media bucket private, with a size and a type limit, CONTRACT
-- phase (tracker 1.11 / 1.14; audit KEA-4; owner decisions D18, D20).
--
-- Why (KEA-4). chat-media is a PUBLIC bucket: the public object URL
-- (/storage/v1/object/public/chat-media/<org>/<phone>/<uuid>.<ext>) serves
-- every customer photo, document, voice note and video to anyone who holds
-- it, without a login, past the storage policy "chat-media org members"
-- (0058); the key itself names the org and the customer's phone number. The
-- bucket has no size or type limit either, so any signed-in member can use it
-- as file hosting, active content (text/html, image/svg+xml) included.
-- Read-only production check 2026-10-16: public = true, file_size_limit and
-- allowed_mime_types null; 27 objects (66.9 MiB), all under the seed org as
-- <org>/<phone>/<uuid>.<ext> (15 PDF, 10 JPEG, 1 OGG, 1 MP4; the largest
-- 17.4 MB); 23 message rows with media: 22 hold the public URL, 1 is null.
--
-- What: one update of the storage.buckets row 'chat-media' (the precedent is
-- 0037 for documents); the DO block raises unless exactly that row changed.
--   * public = false: Storage then serves an object only to a request whose
--     JWT the policy admits, or through a signed URL. The dashboard renders
--     /api/chat-media/<message id> (app/api/chat-media/[id]/route.ts), which
--     signs the object in the member's own session (600 s; voice notes and
--     videos 1 h, renewed by the player before they run out), so the 0058
--     policy re-checks the org folder; outbound media reaches Meta by upload
--     + media id, so delivery never depends on the bucket;
--   * file_size_limit = 52428800 (50 MiB, the Free plan's global cap; D20):
--     both writers skip the copy of a larger file instead of trying; the
--     message is still sent / recorded, media_url stays null and the chat
--     shows "Salinan tidak disimpan";
--   * allowed_mime_types = the 19 types of CHAT_MEDIA_ALLOWED_MIME
--     (lib/storage/chat-media.ts; a vitest keeps both lists identical, order
--     included): WhatsApp's image / audio / video types, the 8 document types
--     the dashboard sends (lib/whatsapp/client.ts), image/webp for stickers
--     (stored as images) and application/octet-stream, the type the writers
--     store anything else as (storageContentType), so an unknown inbound
--     document stays a download and text/html or image/svg+xml is never
--     stored as such. media_mime keeps the original type.
-- Objects, rows and policies are unchanged: the 22 old rows keep their public
-- URL, which the route parses (chatMediaObjectPath); no backfill. New rows
-- hold the bare key '<org>/<safe phone>/<uuid>.<ext>' (the layout the
-- contact delete of D21 finds a contact's files by).
--
-- CONTRACT: apply only AFTER this PR's build is live. Order: merge; Deploy in
-- Easypanel (manual); confirm the Next.js build id changed; reload every open
-- dashboard tab (an old bundle renders media_url directly: the public URLs
-- stop working at the flip and the bare keys written since the deploy are
-- relative links there); with the bucket still public, check old and new
-- media through /api/chat-media; run the pre-flip check below; then apply this
-- file with apply_migration (the LF git blob). Runbook: supabase/README.md,
-- "Contract migrations".
-- D18: a public URL is refused as soon as this is applied, but responses the
-- CDN already holds can be served for about 1 h more (objects carry
-- max-age=3600; a purge needs the Pro plan).
-- D20: after the Pro upgrade (tracker 0.15), raise file_size_limit to
-- 104857600 together with the project's global upload limit (Dashboard >
-- Storage > Settings; SQL cannot read it) and CHAT_MEDIA_MAX_BYTES.
--
-- Pre-flip check (read-only; expect all three counts equal: every stored
-- media_url names an existing object, by a key in the character set the
-- route accepts, [A-Za-z0-9._-] after the org folder; 2026-10-17: 23/23/23):
--   with m as (
--     select case when media_url ~ '^https?://'
--                 then regexp_replace(split_part(media_url, '?', 1),
--                      '^https?://[^/]+/storage/v1/object/(public|sign)/chat-media/', '')
--                 else media_url end as key
--       from public.whatsapp_messages
--      where media_url is not null)
--   select count(*) as with_media, count(o.id) as resolvable,
--          count(*) filter (where m.key ~ '^[0-9a-f-]{36}(/[A-Za-z0-9._-]+)+$') as route_safe
--     from m
--     left join storage.objects o on o.bucket_id = 'chat-media' and o.name = m.key;
--
-- Rollback of the bucket (the code of this PR works with a public bucket too):
--   update storage.buckets set public = true, file_size_limit = null, allowed_mime_types = null
--    where id = 'chat-media';
-- If the CODE must also go back to a build before this PR (the old code
-- renders media_url as a URL and needs the bucket public): redeploy the old
-- build, confirm its build id, and only THEN rewrite the bare keys to the
-- public form. This build keeps writing bare keys until the swap, so a
-- rewrite run only before the redeploy misses the media that arrives while
-- Easypanel builds. The statement is idempotent (rewritten rows no longer
-- match), so running it before as well, or twice, is harmless:
--   update public.whatsapp_messages
--      set media_url = '<project API URL>/storage/v1/object/public/chat-media/' || media_url
--    where media_url is not null and media_url !~ '^https?://';
-- After the flip the default is to roll forward with a patch build. Once a
-- SECOND tenant has real data, never make chat-media public again (it would
-- serve every tenant's media by URL, KEA-4): roll forward, or first close the
-- tenant-2 gate again (supabase/README.md, "Contract migrations"). Refresh
-- fingerprint/production.txt after any of these.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

do $$
declare
    v_rows integer;
begin
    update storage.buckets
       set public = false,
           file_size_limit = 52428800,
           allowed_mime_types = array[
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
           ]
     where id = 'chat-media';
    get diagnostics v_rows = row_count;

    if v_rows <> 1 then
        raise exception '0067 refused: expected to update exactly one storage.buckets row (id chat-media), updated %', v_rows;
    end if;
end $$;
