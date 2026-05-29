-- M4.x — Link a vendor directory row to its originating WhatsApp contact.
-- A vendor may originate from a WhatsApp chat (promoted from Contacts) or be
-- added manually (no chat). chat_phone is the explicit, nullable link to the
-- canonical contact key. on delete set null: deleting the contact unlinks the
-- vendor row but keeps the directory entry.

alter table public.vendors
    add column if not exists chat_phone text
        references public.whatsapp_chats(phone_number) on delete set null;

-- One directory row per linked contact — prevents double-promote. Partial so
-- manually-added vendors (chat_phone null) are unconstrained.
create unique index if not exists uq_vendors_chat_phone
    on public.vendors(chat_phone)
    where chat_phone is not null;

comment on column public.vendors.chat_phone is
    'Nullable link to whatsapp_chats(phone_number) when this vendor originated from a WhatsApp contact (promoted in Contacts). Null = manually-added vendor with no chat.';
