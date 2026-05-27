-- Event Organizer pivot — Milestone 1 schema alignment
--
-- Extends two existing tables to match the Sailendra Organizer workflow:
--   1. whatsapp_chats  → CRM-shaped lead profile (email, event interest,
--                        participant count, location, goals, stage, …)
--   2. orders          → event booking fields (date, venue, headcount, DP
--                        + pelunasan, meeting link, event type)
--
-- All additions are nullable / non-breaking so existing rows survive untouched.
-- Idempotent (`if not exists`) so the file can be re-applied safely.

-- ─────────────────────────────────────────────────────────────────────────────
-- whatsapp_chats: lead capture & CRM
-- ─────────────────────────────────────────────────────────────────────────────

alter table if exists public.whatsapp_chats
  add column if not exists email             text,
  add column if not exists event_interest    text,
  add column if not exists participant_count integer,
  add column if not exists location_pref     text,
  add column if not exists event_date_pref   text,   -- free-form ("akhir bulan", "Q1 2026")
  add column if not exists event_goals       text,
  add column if not exists budget_range      text,
  add column if not exists lead_stage        text,
  add column if not exists assigned_to       text,   -- internal sales handle (e.g. "MJ")
  add column if not exists source            text,   -- whatsapp | instagram | referral | website
  add column if not exists tags              text[] default array[]::text[],
  add column if not exists notes             text;

-- Constrain lead_stage to known values (NULL allowed for legacy rows).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_chats_lead_stage_check'
  ) then
    alter table public.whatsapp_chats
      add constraint whatsapp_chats_lead_stage_check
      check (
        lead_stage is null
        or lead_stage = any (array[
          'new', 'qualifying', 'quoted',
          'scheduled', 'booked', 'won', 'lost'
        ])
      );
  end if;
end $$;

create index if not exists idx_whatsapp_chats_lead_stage
  on public.whatsapp_chats(lead_stage)
  where lead_stage is not null;

create index if not exists idx_whatsapp_chats_assigned_to
  on public.whatsapp_chats(assigned_to)
  where assigned_to is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- orders: event booking specifics
-- ─────────────────────────────────────────────────────────────────────────────

alter table if exists public.orders
  add column if not exists event_date        timestamptz,
  add column if not exists venue             text,
  add column if not exists headcount         integer,
  add column if not exists event_type        text,   -- team_building | capacity_building | gathering | wedding | other
  add column if not exists dp_amount         numeric default 0,
  add column if not exists dp_paid_at        timestamptz,
  add column if not exists pelunasan_amount  numeric default 0,
  add column if not exists pelunasan_paid_at timestamptz,
  add column if not exists meeting_link      text;   -- Zoom / GMeet URL for consultation or hybrid event

create index if not exists idx_orders_event_date
  on public.orders(event_date)
  where event_date is not null;
