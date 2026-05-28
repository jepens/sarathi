-- Manual-edit protection for contact_name.
--
-- When an admin edits a contact's name from the dashboard Contacts page we
-- set contact_name_locked = true. The AI's save_lead_info tool then stops
-- overwriting contact_name on later turns (other lead fields still update).
-- Default false → the AI manages the name until a human takes over. The admin
-- can unlock from the UI to hand the name back to the AI.
--
-- Non-breaking (nullable-safe via NOT NULL DEFAULT false) and idempotent.

alter table if exists public.whatsapp_chats
  add column if not exists contact_name_locked boolean not null default false;
