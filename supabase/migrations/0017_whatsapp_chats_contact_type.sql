-- Classify WhatsApp contacts (lead vs vendor) + light vendor detail.
--
-- Many inbound WhatsApp chats are vendors/sales pitching services, not client
-- leads. They polluted the lead pipeline view and had no place to record what
-- they offer. This adds:
--   contact_type    'lead' (default) | 'vendor' | 'other'  → triage + filter
--   vendor_category mirrors public.vendors.category (nullable)
--   vendor_offering free-text: what the vendor offers (e.g. "standby ambulance")
--
-- The authoritative supplier directory stays public.vendors; a vendor contact
-- can be promoted there from the dashboard. These columns let the Contacts page
-- flag/filter vendors and prefill that promotion.
--
-- text + CHECK (not a native enum) to match the codebase convention
-- (lead_stage, orders.event_type, products.type) and stay easy to evolve.
-- Non-breaking + idempotent.

alter table if exists public.whatsapp_chats
  add column if not exists contact_type    text not null default 'lead',
  add column if not exists vendor_category  text,
  add column if not exists vendor_offering  text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_chats_contact_type_check'
  ) then
    alter table public.whatsapp_chats
      add constraint whatsapp_chats_contact_type_check
      check (contact_type in ('lead', 'vendor', 'other'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_chats_vendor_category_check'
  ) then
    alter table public.whatsapp_chats
      add constraint whatsapp_chats_vendor_category_check
      check (
        vendor_category is null
        or vendor_category = any (array[
          'catering', 'venue', 'transport', 'entertainment',
          'photography', 'decoration', 'mc', 'other'
        ])
      );
  end if;
end $$;

-- Partial index — we filter the non-default (vendor/other) rows in the UI.
create index if not exists idx_whatsapp_chats_contact_type
  on public.whatsapp_chats(contact_type)
  where contact_type <> 'lead';
