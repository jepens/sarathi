-- M4.x — Auto-materialize a directory row when a contact is tagged as a vendor.
-- A WhatsApp contact tagged contact_type='vendor' (by the AI or manually) should
-- appear in the Vendor Directory without a manual "promote" step. We create a
-- linked vendors row (verified=false; admin vets via the Vendors page). The link
-- (chat_phone) dedupes and powers cross-navigation.

create or replace function public.sync_vendor_from_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Idempotent: only create if this contact isn't already linked to a row.
    if not exists (
        select 1 from public.vendors v where v.chat_phone = new.phone_number
    ) then
        insert into public.vendors (name, category, phone, email, notes, chat_phone, verified)
        values (
            coalesce(new.contact_name, new.phone_number),
            -- vendor_category mirrors the vendors category enum; fall back to
            -- 'other' defensively so a stray value never aborts the contact write.
            case
                when new.vendor_category in (
                    'catering','venue','transport','entertainment',
                    'photography','decoration','mc','other'
                ) then new.vendor_category
                else 'other'
            end,
            new.phone_number,
            new.email,
            new.vendor_offering,
            new.phone_number,
            false
        );
    end if;
    return new;
end;
$$;

-- New contact created already tagged as vendor.
drop trigger if exists trg_sync_vendor_on_insert on public.whatsapp_chats;
create trigger trg_sync_vendor_on_insert
    after insert on public.whatsapp_chats
    for each row
    when (new.contact_type = 'vendor')
    execute function public.sync_vendor_from_contact();

-- Transition INTO vendor. `update of contact_type` restricts firing to actual
-- tag changes — NOT the frequent last_message_at bumps on every inbound — so a
-- directory row the admin deleted is not resurrected by ordinary chat activity.
drop trigger if exists trg_sync_vendor_on_tag on public.whatsapp_chats;
create trigger trg_sync_vendor_on_tag
    after update of contact_type on public.whatsapp_chats
    for each row
    when (new.contact_type = 'vendor' and new.contact_type is distinct from old.contact_type)
    execute function public.sync_vendor_from_contact();

-- One-time backfill: contacts already tagged vendor that have no directory row.
insert into public.vendors (name, category, phone, email, notes, chat_phone, verified)
select
    coalesce(c.contact_name, c.phone_number),
    case
        when c.vendor_category in (
            'catering','venue','transport','entertainment',
            'photography','decoration','mc','other'
        ) then c.vendor_category
        else 'other'
    end,
    c.phone_number,
    c.email,
    c.vendor_offering,
    c.phone_number,
    false
from public.whatsapp_chats c
where c.contact_type = 'vendor'
  and not exists (
      select 1 from public.vendors v where v.chat_phone = c.phone_number
  );
