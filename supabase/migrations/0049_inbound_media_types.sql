-- Inbound (customer) media. 0048 added media columns + the chat-media bucket for
-- ADMIN-sent photos/documents; this widens media_type so we can also store what
-- customers send us: voice notes (audio) and video. Stickers are stored as
-- 'image' (they're webp images). Inbound media is downloaded from Meta by the
-- webhook into the same chat-media bucket and rendered inline in the inbox.

-- Drop whatever CHECK currently guards media_type (0048 created an inline,
-- auto-named constraint `whatsapp_messages_media_type_check`; match by
-- definition so we're safe even if the name differs), then re-add the widened
-- one. Idempotent: re-running finds no matching constraint and just re-adds.
do $$
declare
    c record;
begin
    for c in
        select con.conname
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = 'public'
          and rel.relname = 'whatsapp_messages'
          and con.contype = 'c'
          and pg_get_constraintdef(con.oid) ilike '%media_type%'
    loop
        execute format('alter table public.whatsapp_messages drop constraint %I', c.conname);
    end loop;
end $$;

alter table public.whatsapp_messages
    add constraint whatsapp_messages_media_type_check
    check (media_type is null or media_type in ('image', 'document', 'audio', 'video'));
