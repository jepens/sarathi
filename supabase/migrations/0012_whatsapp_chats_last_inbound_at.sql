-- Track the timestamp of the last INBOUND (customer) message per chat.
--
-- Meta's 24-hour customer service window is measured from the customer's
-- last reply — not from last_message_at (which also moves when WE send an
-- outbound message). The chat list uses this to badge conversations where
-- the window has expired (or never opened), so the admin knows to use a
-- template message instead of free-form text.

alter table public.whatsapp_chats
    add column if not exists last_inbound_at timestamptz;

-- Backfill from existing message history: the most recent role='user'
-- message per phone_number.
update public.whatsapp_chats c
set last_inbound_at = sub.max_inbound
from (
    select phone_number, max(created_at) as max_inbound
    from public.whatsapp_messages
    where role = 'user'
    group by phone_number
) sub
where c.phone_number = sub.phone_number
  and c.last_inbound_at is null;
