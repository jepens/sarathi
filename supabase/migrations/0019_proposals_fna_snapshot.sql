-- M3.x — FNA (Form Need Analysis) snapshot on proposals.
-- Stores the client-requirements summary the admin reviewed at send time:
-- the structured CRM fields (event type, pax, location, date, goals, budget,
-- notes, source) plus an optional AI-generated narrative. This is an immutable
-- record of WHAT the proposal was based on — the live whatsapp_chats fields can
-- change later, but this snapshot freezes the brief for audit/traceability.

alter table public.proposals
    add column if not exists fna_snapshot jsonb;

comment on column public.proposals.fna_snapshot is
    'Snapshot of client needs (FNA) at send time: { event_interest, participant_count, location_pref, event_date_pref, event_goals, budget_range, notes, source, ai_summary, captured_at }. Immutable audit of the brief the proposal was built against.';
