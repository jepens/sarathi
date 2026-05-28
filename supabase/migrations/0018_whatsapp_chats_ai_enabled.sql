-- Per-chat AI auto-reply switch (human takeover).
--
-- The webhook auto-replies (via the AI) to every inbound message. When an admin
-- wants to handle a conversation manually, they flip ai_enabled = false and the
-- webhook stops generating automatic replies for that contact — the inbound
-- message is still stored (so it shows in the inbox + resets the 24h window),
-- only the AI auto-reply is skipped. Default true = AI handles it.
--
-- Non-breaking + idempotent.

alter table if exists public.whatsapp_chats
  add column if not exists ai_enabled boolean not null default true;
