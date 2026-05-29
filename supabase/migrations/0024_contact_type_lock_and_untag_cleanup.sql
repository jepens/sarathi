-- M4.x — Make manual re-classification of a contact durable + self-cleaning.
-- Problem: the AI (save_lead_info) can tag a real client as 'vendor', and even
-- after an admin corrects it the AI re-flips it and the auto-created directory
-- row lingers. Two fixes:
--   (A) contact_type_locked — once a human sets the type, the AI must not change it.
--   (B) cleanup_vendor_on_untag — leaving the vendor tag drops the auto-created
--       (still-unverified) directory row; vetted vendors are kept.

-- (A) lock flag, mirroring contact_name_locked.
alter table public.whatsapp_chats
    add column if not exists contact_type_locked boolean not null default false;

comment on column public.whatsapp_chats.contact_type_locked is
    'When true, a human set contact_type manually; save_lead_info must not let the AI overwrite it.';

-- (B) drop the auto-created directory row when a contact leaves the vendor tag.
create or replace function public.cleanup_vendor_on_untag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    delete from public.vendors
    where chat_phone = new.phone_number
      and verified = false;   -- never delete a vendor an admin has vetted
    return new;
end;
$$;

drop trigger if exists trg_cleanup_vendor_on_untag on public.whatsapp_chats;
create trigger trg_cleanup_vendor_on_untag
    after update of contact_type on public.whatsapp_chats
    for each row
    when (old.contact_type = 'vendor' and new.contact_type is distinct from old.contact_type)
    execute function public.cleanup_vendor_on_untag();

-- Same hardening as 0023: keep the SECURITY DEFINER function out of the public RPC surface.
revoke execute on function public.cleanup_vendor_on_untag() from public;
revoke execute on function public.cleanup_vendor_on_untag() from anon;
revoke execute on function public.cleanup_vendor_on_untag() from authenticated;
