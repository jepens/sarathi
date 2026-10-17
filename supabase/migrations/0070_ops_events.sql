-- Tracker 3.5 (minimal version, part of the tenant-2 gate): operational events
-- the team is alerted about. Fase 2 design review (docs/FASE2_DESIGN.md,
-- critique "No alerting"): every path that drops work on purpose or keeps
-- failing (a rejected webhook signature, a webhook error, a queue job that
-- gave up, an invalid WhatsApp token, a quota stop) must reach the team.
-- Owner decision 2026-10-18: alerts are emailed through Resend.
--
-- public.ops_events: one row per event. Server code inserts with the service
-- role (lib/ops/events.ts). The every-minute queue cron emails the unsent
-- events of each kind at most once per hour per kind and stamps alerted_at
-- (lib/ops/alerts.ts). detail never holds personal data: the writers pass
-- fixed texts, ids and Meta error codes, never a phone number, a name or
-- message text. cleanup_old_ops_events() deletes rows older than 30 days,
-- hourly with the other cleanups.
--
-- Service role only, like message_queue, rate_limits and whatsapp_integrations
-- (0069): RLS on, a deny policy, no table or sequence privilege for anon or
-- authenticated. The cleanup function is executable by the service role only.
--
-- Expand: nothing reads or writes the table before the PR that ships it is
-- deployed; applied after the owner's review (D1).
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

create table public.ops_events (
    id bigint generated always as identity primary key,
    created_at timestamptz not null default now(),
    kind text not null,
    org_id uuid references public.organizations (id) on delete cascade,
    detail text not null default '',
    alerted_at timestamptz,
    constraint ops_events_kind_check check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
    constraint ops_events_detail_check check (char_length(detail) <= 500)
);

-- The cron reads only the unsent events; the others are history.
create index ops_events_unsent_idx on public.ops_events (kind, created_at) where alerted_at is null;
create index ops_events_created_at_idx on public.ops_events (created_at);
-- Covers the org foreign key (cascading deletes, performance advisor).
create index ops_events_org_id_idx on public.ops_events (org_id);

alter table public.ops_events enable row level security;
revoke all on table public.ops_events from anon, authenticated;
revoke all on sequence public.ops_events_id_seq from anon, authenticated;
create policy "service_role only" on public.ops_events
    as permissive for all to anon, authenticated
    using (false) with check (false);

create function public.cleanup_old_ops_events()
returns void
language sql
set search_path = ''
as $$
    delete from public.ops_events where created_at < now() - interval '30 days';
$$;
revoke execute on function public.cleanup_old_ops_events() from public, anon, authenticated;
grant execute on function public.cleanup_old_ops_events() to service_role;
