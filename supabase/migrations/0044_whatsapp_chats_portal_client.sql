-- Phase 2 handoff (Sarathi → Portal): remember the canonical Organization a
-- lead is linked to in the Portal (its `clients` row), plus the URL of the most
-- recent draft proposal created from this lead.
--
-- The Portal's `clients` table is the canonical Organization. Sarathi is
-- contact/lead-centric (keyed by phone number), so it just PINS the identity
-- here: a human links-or-creates the Portal client on the FIRST handoff, and we
-- remember it forever. Later handoffs for the same lead skip the picker and
-- reuse this id, which also prevents creating duplicate Portal clients.
--
-- Additive & nullable — existing rows survive untouched. Idempotent
-- (`if not exists`) so the file can be re-applied safely.

alter table if exists public.whatsapp_chats
    add column if not exists portal_client_id        uuid,
    add column if not exists portal_last_proposal_url text;

comment on column public.whatsapp_chats.portal_client_id is
    'Portal clients.id this lead is linked to (Phase 2 handoff). Pinned by a human on the first handoff; lets later handoffs skip the picker and avoids duplicate Portal clients.';

comment on column public.whatsapp_chats.portal_last_proposal_url is
    'URL of the most recent Portal draft proposal created from this lead via handoff.';
