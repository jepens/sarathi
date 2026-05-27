-- Outbound message delivery tracking.
--
-- Meta's `POST /messages` returns 200 immediately just to acknowledge receipt
-- of the request — the actual delivery (or failure) is reported asynchronously
-- via webhook status callbacks (sent/delivered/read/failed). Without storing
-- a `wa_message_id` alongside each outbound row, we can't correlate those
-- callbacks back to the row, so failures look like silent success in the UI.
--
-- This migration:
--   - adds wa_message_id (Meta's `wamid.*`)
--   - adds status enum (sent/delivered/read/failed) — defaults to 'sent'
--     because we only insert the row after Meta returns 200
--   - adds error_code / error_title / error_detail to capture failure info
--     from the status callback (e.g. 131047 = past 24h customer-service window)
--   - adds index on wa_message_id for O(log n) status-callback lookup
-- Inbound rows (role='user') are not affected — their wa_message_id stays
-- null since we don't currently store the inbound wamid.

alter table public.whatsapp_messages
    add column if not exists wa_message_id text,
    add column if not exists status text,
    add column if not exists error_code integer,
    add column if not exists error_title text,
    add column if not exists error_detail text,
    add column if not exists status_updated_at timestamptz;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'whatsapp_messages_status_check') then
        alter table public.whatsapp_messages
            add constraint whatsapp_messages_status_check
            check (status is null or status in ('sent', 'delivered', 'read', 'failed'));
    end if;
end $$;

create index if not exists idx_whatsapp_messages_wa_message_id
    on public.whatsapp_messages(wa_message_id)
    where wa_message_id is not null;
