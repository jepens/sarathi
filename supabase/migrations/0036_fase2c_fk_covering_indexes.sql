-- Fase 2c follow-up: covering indexes for the composite FKs added in 0034.
-- Postgres needs an index whose leading columns match the FK columns to keep
-- ON DELETE / cascade checks on whatsapp_chats efficient once there is real
-- multi-tenant data. Resolves the unindexed_foreign_keys advisories from 0034.
-- Purely additive — safe with live code.
create index if not exists idx_orders_org_customer_phone
  on public.orders (org_id, customer_phone);
create index if not exists idx_proposals_org_lead_phone
  on public.proposals (org_id, lead_phone);
create index if not exists idx_vendors_org_chat_phone
  on public.vendors (org_id, chat_phone);
create index if not exists idx_whatsapp_messages_org_phone
  on public.whatsapp_messages (org_id, phone_number);

-- Cleanup: orders had two identical single-column indexes on customer_phone
-- (duplicate_index advisor). Keep idx_orders_customer_phone; drop the redundant
-- twin. Neither backs a constraint (the single-column FK was dropped in 0034).
drop index if exists public.orders_customer_phone_idx;
