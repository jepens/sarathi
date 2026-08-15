-- Reply / quote (WhatsApp-Web style). A message can be a reply to an earlier
-- one: reply_to_wamid holds the wa_message_id (wamid) of the quoted message.
--
-- Outbound: the admin replies from the dashboard; the send route passes
-- context.message_id to Meta (so the customer's phone shows the quote too) and
-- stores the parent wamid here. Inbound: when a customer replies to one of our
-- messages, the webhook stores message.context.id here. The dashboard resolves
-- the quoted message locally by matching this against wa_message_id.

alter table public.whatsapp_messages
    add column if not exists reply_to_wamid text;
