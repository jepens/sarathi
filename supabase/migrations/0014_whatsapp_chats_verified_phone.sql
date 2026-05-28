-- Phase C of BSUID adoption: store the best-known REAL phone number for a
-- contact, separate from the primary key.
--
-- In the hybrid model, phone_number (PK) is usually a real phone but for a
-- username-only contact it is a BSUID fallback. verified_phone holds the
-- actual E.164-ish phone whenever Meta reveals it — via a REQUEST_CONTACT_INFO
-- share, a contacts-type message, or simply a wa_id present on an inbound
-- webhook. This lets us reach the customer (e.g. authentication templates
-- that still require a phone number) WITHOUT the costly re-key of the PK and
-- its NO ACTION foreign keys (whatsapp_messages, orders, proposals).

alter table public.whatsapp_chats
    add column if not exists verified_phone text;

-- Backfill: for existing contacts whose PK already looks like a phone number
-- (all digits, 8-15 long), the PK *is* the verified phone.
update public.whatsapp_chats
set verified_phone = phone_number
where verified_phone is null
  and phone_number ~ '^[0-9]{8,15}$';
