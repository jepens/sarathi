-- Fase 2c, step A (EXPAND phase of an expand/contract rollout). APPLIED to prod.
--
-- Goal: let the new code use onConflict:'org_id,phone_number' WHILE the existing
-- phone_number primary key still exists, so currently-deployed code (which uses
-- onConflict:'phone_number') keeps working until the new code is live.
--
-- This is purely additive: it adds a composite UNIQUE constraint alongside the
-- phone_number PK. It does NOT remove global phone uniqueness yet — that is the
-- later "contract" migration 0034, applied only after the new code deploys.
--
-- Safe to apply with old code running: validated 0 duplicate (org_id, phone_number)
-- pairs on production before applying.
alter table public.whatsapp_chats
  add constraint whatsapp_chats_org_phone_key unique (org_id, phone_number);

comment on constraint whatsapp_chats_org_phone_key on public.whatsapp_chats is
  'Fase 2c expand-phase composite unique. Transitional: becomes the primary key in 0034 once new code (composite onConflict + org-scoped reads) is deployed; the phone_number-only PK is dropped there.';
