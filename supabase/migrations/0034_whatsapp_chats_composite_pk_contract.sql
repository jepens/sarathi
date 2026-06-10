-- Fase 2c, step B (CONTRACT phase). DO NOT APPLY until the new code
-- (composite onConflict + org-scoped service-role reads) is LIVE in production.
--
-- Why the ordering matters: before the new code is deployed, the running app
-- (webhook + the per-minute Vercel queue cron) relies on phone_number being
-- globally unique (onConflict:'phone_number'). This migration removes that, so
-- applying it early breaks every inbound-message write until the deploy lands.
--
-- What it does: swaps whatsapp_chats identity from (phone_number) to
-- (org_id, phone_number) and repoints the 4 FKs that referenced it, so two
-- tenants can finally own a row for the same customer phone without colliding.
--
-- Validated against production data before writing (all checks returned 0):
--   * 0 referencing rows would violate a composite (org_id, phone) FK
--   * 0 duplicate (org_id, phone_number) and (org_id, bsuid) pairs
-- and dry-run applied cleanly inside a rolled-back transaction (PG 17.6).
--
-- apply_migration / supabase CLI wraps this file in a single transaction, so it
-- is atomic: any failure rolls the whole thing back, leaving the live PK intact.

-- 1. Drop the 4 FKs that reference whatsapp_chats(phone_number).
alter table public.orders            drop constraint orders_customer_phone_fkey;
alter table public.proposals         drop constraint proposals_lead_phone_fkey;
alter table public.vendors           drop constraint vendors_chat_phone_fkey;
alter table public.whatsapp_messages drop constraint whatsapp_messages_phone_number_fkey;

-- 2. Swap the PK. Drop the transitional composite unique from 0033 first — the
--    new composite PK provides the same (org_id, phone_number) uniqueness.
alter table public.whatsapp_chats drop constraint whatsapp_chats_org_phone_key;
alter table public.whatsapp_chats drop constraint whatsapp_chats_pkey;
alter table public.whatsapp_chats add constraint whatsapp_chats_pkey primary key (org_id, phone_number);

-- 3. Recompose the 4 FKs as (org_id, <phone col>). Every referencing table
--    already carries org_id (migration 0027); today all rows align to the same
--    org as their chat (single tenant), so the constraints validate immediately.
alter table public.orders
  add constraint orders_org_customer_phone_fkey
  foreign key (org_id, customer_phone) references public.whatsapp_chats(org_id, phone_number);

alter table public.proposals
  add constraint proposals_org_lead_phone_fkey
  foreign key (org_id, lead_phone) references public.whatsapp_chats(org_id, phone_number) on delete cascade;

-- vendors.chat_phone is nullable with ON DELETE SET NULL. Use the column-list
-- form (PG15+) so deleting a chat nulls ONLY chat_phone, never org_id (NOT NULL).
alter table public.vendors
  add constraint vendors_org_chat_phone_fkey
  foreign key (org_id, chat_phone) references public.whatsapp_chats(org_id, phone_number) on delete set null (chat_phone);

alter table public.whatsapp_messages
  add constraint whatsapp_messages_org_phone_fkey
  foreign key (org_id, phone_number) references public.whatsapp_chats(org_id, phone_number);

-- 4. bsuid uniqueness becomes per-org (was a global partial unique index).
drop index if exists public.idx_whatsapp_chats_bsuid;
create unique index idx_whatsapp_chats_org_bsuid
  on public.whatsapp_chats (org_id, bsuid) where bsuid is not null;
