-- Security: drop legacy "Allow public access" RLS policies on whatsapp_chats
-- and whatsapp_messages. These were created by an older migration and gave
-- the `public` role (which includes anon) full CRUD on the entire chat
-- history — anyone with the NEXT_PUBLIC_SUPABASE_ANON_KEY could read or
-- modify any conversation.
--
-- The webhook path was refactored to use the service_role client via
-- `lib/supabase/service.ts:createServiceOrServerClient()` so it bypasses RLS
-- entirely. Authenticated dashboard users continue to get full access via
-- the existing `auth full access` policy. Anon clients now have NO access.

drop policy if exists "Allow public access to whatsapp_chats"
    on public.whatsapp_chats;

drop policy if exists "Allow public access to whatsapp_messages"
    on public.whatsapp_messages;
