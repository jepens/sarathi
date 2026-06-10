-- Fase 2c, step C. DO NOT APPLY until 0034 is applied AND the new code is live.
--
-- The org_id column DEFAULT (Sailendra's uuid, added in 0027) was a transition
-- backstop so service-role inserts that hadn't been taught about org_id still
-- landed somewhere valid. Every write path to these two tables now sets org_id
-- explicitly (webhook, queue, history/logSystemMessage, AI tools, RAG createOrder,
-- manual send + send-template). Dropping the default makes a future code path
-- that forgets org_id fail loudly (NOT NULL violation) instead of silently
-- mis-attributing a tenant's row to Sailendra.
--
-- Scope: only whatsapp_chats + whatsapp_messages — the tables fully audited in
-- Fase 2c. orders / proposals / vendors / message_queue keep their DEFAULT until
-- their write paths get the same treatment in a later pass (e.g. dashboard
-- order-creation flows are not yet audited for explicit org_id).
alter table public.whatsapp_chats    alter column org_id drop default;
alter table public.whatsapp_messages alter column org_id drop default;
