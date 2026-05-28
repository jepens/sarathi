-- Phase A of BSUID adoption (Meta business-scoped user IDs).
--
-- Meta is rolling out usernames + BSUIDs: from March 2026 webhooks carry a
-- `user_id` (BSUID, e.g. "ID.26557548613939612") alongside wa_id; from June
-- 2026 the wa_id/from fields MAY contain a BSUID instead of a phone number.
-- Our CRM keys on phone_number, so we add a secondary identity column to
-- (a) record the stable BSUID and (b) re-thread returning customers who
-- arrive with a BSUID but no phone number.
--
-- Hybrid strategy: phone_number stays the primary key; bsuid is a secondary
-- identity used for matching. No FK changes — lowest-risk path to survive
-- the June rollout.

alter table public.whatsapp_chats
    add column if not exists bsuid text;

-- A BSUID identifies exactly one contact within our portfolio. Partial
-- unique index (only enforced when bsuid is set) lets us look a contact up
-- by BSUID and prevents accidental duplicates.
create unique index if not exists idx_whatsapp_chats_bsuid
    on public.whatsapp_chats(bsuid)
    where bsuid is not null;
