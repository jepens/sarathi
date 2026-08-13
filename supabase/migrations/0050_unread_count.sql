-- Per-chat unread badge (WhatsApp-Web style). The unread_count column already
-- exists (nullable, unused). This tightens it to NOT NULL DEFAULT 0 and adds an
-- ATOMIC increment RPC the webhook calls whenever a genuinely-new inbound
-- message is stored. Mark-as-read (reset to 0) is a plain UPDATE from the
-- dashboard when the admin opens the chat, so it needs no function here.

-- Backfill any legacy NULLs, then lock the column down.
update public.whatsapp_chats set unread_count = 0 where unread_count is null;

alter table public.whatsapp_chats
    alter column unread_count set default 0,
    alter column unread_count set not null;

-- Atomic increment — `col = col + 1` can't be expressed through the supabase-js
-- query builder, and read-then-write from the webhook would race concurrent
-- inbound messages. coalesce guards any row that predates the NOT NULL.
create or replace function public.bump_unread(p_org uuid, p_phone text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.whatsapp_chats
    set unread_count = coalesce(unread_count, 0) + 1
    where org_id = p_org and phone_number = p_phone;
$$;

-- Only the webhook (service role) increments; the dashboard resets via a direct
-- UPDATE under RLS. Lock the function so anon/authenticated can't call it
-- (Supabase auto-grants EXECUTE to public on new functions — revoke it).
revoke all on function public.bump_unread(uuid, text) from public;
revoke all on function public.bump_unread(uuid, text) from anon;
revoke all on function public.bump_unread(uuid, text) from authenticated;
grant execute on function public.bump_unread(uuid, text) to service_role;
