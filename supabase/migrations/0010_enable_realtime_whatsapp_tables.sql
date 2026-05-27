-- Enable realtime on whatsapp_chats + whatsapp_messages.
--
-- ChatWindow.tsx subscribes to postgres_changes on these tables so the
-- dashboard updates immediately when (a) a customer message arrives via
-- the webhook or (b) admin sends a manual reply. The supabase_realtime
-- publication was empty for these tables, so the channel subscription
-- silently never fired and the UI relied entirely on a 10-second polling
-- fallback — which felt like "send doesn't work" to the admin.
--
-- RLS still applies to realtime events: only authenticated dashboard
-- users (who have the `auth full access` policy on these tables) will
-- receive the events. Anon clients get nothing.

alter publication supabase_realtime add table public.whatsapp_messages;
alter publication supabase_realtime add table public.whatsapp_chats;
