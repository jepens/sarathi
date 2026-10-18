-- Tracker 3.5 (minimal version, part of the tenant-2 gate): operational events
-- the team is alerted about. Fase 2 design review (docs/FASE2_DESIGN.md,
-- critique "No alerting"): every path that drops work on purpose or keeps
-- failing (a rejected webhook signature, a webhook error, a queue job that
-- gave up, an invalid WhatsApp token, a quota stop) must reach the team.
-- Owner decision 2026-10-18: alerts are emailed through Resend.
--
-- public.ops_events: one row per kind, org and minute, with a count, written
-- by record_ops_event() (lib/ops/events.ts). A flood of one kind adds one row a
-- minute, not one per event. detail is the first example of the minute and
-- never holds personal data: the writers pass fixed texts, ids and error codes,
-- never a phone number, a name or message text.
--
-- public.ops_alert_state: when each (kind, org) group was last emailed. The
-- every-minute queue cron (lib/ops/alerts.ts) calls claim_ops_alerts(), which
-- in one statement claims the groups that have unsent events of a finished
-- minute and were not emailed in the last hour, and returns their totals; it
-- emails them, then mark_ops_alerts_sent() stamps the events, or on a failed
-- send release_ops_alerts() frees the groups for the next run. The hour is per
-- (kind, org), so a flood of one kind never hides another kind, and one org's
-- outage never holds back another org's alert. claim_ops_daily_summary() and
-- ops_events_summary() serve a daily summary email, whose absence tells the
-- team the cron has stopped. report_stale_queue_failures() turns queue jobs
-- the database itself gave up on (claim_queue_jobs, 0042: a worker that died
-- mid-job) into events. cleanup_old_ops_events() deletes events and state
-- older than 30 days, hourly with the other cleanups.
--
-- Service role only, like message_queue, rate_limits and whatsapp_integrations
-- (0069): RLS on, a deny policy, no table or sequence privilege for anon or
-- authenticated; every function is executable by the service role only.
--
-- Expand: nothing reads or writes these objects before the PR that ships them
-- is deployed; applied after the owner's review (D1).
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

create table public.ops_events (
    id bigint generated always as identity primary key,
    kind text not null,
    org_id uuid references public.organizations (id) on delete cascade,
    minute timestamptz not null,
    first_at timestamptz not null,
    last_at timestamptz not null,
    count integer not null default 1,
    detail text not null default '',
    alerted_at timestamptz,
    constraint ops_events_kind_check check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
    constraint ops_events_detail_check check (char_length(detail) <= 500),
    constraint ops_events_count_check check (count > 0)
);

-- One unsent row per kind, org and minute (events without an org count as one
-- org: nulls not distinct): record_ops_event adds to it, and the alert claim
-- scans only these rows.
create unique index ops_events_unsent_key on public.ops_events (kind, org_id, minute) nulls not distinct
    where alerted_at is null;
-- The cleanup deletes by minute.
create index ops_events_minute_idx on public.ops_events (minute);
-- Covers the org foreign key (cascading deletes, performance advisor).
create index ops_events_org_id_idx on public.ops_events (org_id);

create table public.ops_alert_state (
    id bigint generated always as identity primary key,
    kind text not null,
    org_id uuid references public.organizations (id) on delete cascade,
    last_alerted_at timestamptz not null,
    constraint ops_alert_state_kind_org_id_key unique nulls not distinct (kind, org_id)
);
-- Covers the org foreign key (cascading deletes, performance advisor).
create index ops_alert_state_org_id_idx on public.ops_alert_state (org_id);

alter table public.ops_events enable row level security;
alter table public.ops_alert_state enable row level security;
revoke all on table public.ops_events from anon, authenticated;
revoke all on sequence public.ops_events_id_seq from anon, authenticated;
revoke all on table public.ops_alert_state from anon, authenticated;
revoke all on sequence public.ops_alert_state_id_seq from anon, authenticated;
create policy "service_role only" on public.ops_events
    as permissive for all to anon, authenticated
    using (false) with check (false);
create policy "service_role only" on public.ops_alert_state
    as permissive for all to anon, authenticated
    using (false) with check (false);

-- Adds p_count events (the server's in-process throttle folds suppressed events
-- into the next call) to the unsent row of this kind, org and minute.
create function public.record_ops_event(p_kind text, p_org uuid, p_detail text, p_count integer default 1)
returns void
language sql
set search_path = ''
as $$
    insert into public.ops_events as e (kind, org_id, minute, first_at, last_at, count, detail)
    values (p_kind, p_org, date_trunc('minute', now()), now(), now(),
            greatest(coalesce(p_count, 1), 1), left(coalesce(p_detail, ''), 500))
    on conflict (kind, org_id, minute) where alerted_at is null
    do update set count = e.count + excluded.count,
                  last_at = excluded.last_at,
                  detail = case when e.detail = '' then excluded.detail else e.detail end;
$$;

-- Claims every (kind, org) group that has unsent events of a finished minute
-- and was not emailed within p_cooldown_seconds, and returns one row per
-- claimed group: its totals, up to three example details, the claim's stamp
-- and the minute cutoff. Atomic: the claim is an upsert of the group's state
-- row guarded by the cooldown, so two overlapping runs never claim the same
-- group. The events are not stamped here; mark_ops_alerts_sent does that once
-- the email is out.
create function public.claim_ops_alerts(p_cooldown_seconds integer default 3600)
returns table (kind text, org_id uuid, events bigint, first_at timestamptz, last_at timestamptz,
               details text[], stamp timestamptz, cutoff timestamptz)
language sql
set search_path = ''
as $$
    with due as (
        insert into public.ops_alert_state as s (kind, org_id, last_alerted_at)
        select distinct e.kind, e.org_id, now()
          from public.ops_events e
         where e.alerted_at is null
           and e.minute < date_trunc('minute', now())
        on conflict (kind, org_id) do update
            set last_alerted_at = excluded.last_alerted_at
            where s.last_alerted_at < now() - make_interval(secs => p_cooldown_seconds)
        returning s.kind, s.org_id
    )
    select e.kind, e.org_id, sum(e.count)::bigint, min(e.first_at), max(e.last_at),
           (array_agg(distinct e.detail) filter (where e.detail <> ''))[1:3],
           now(), date_trunc('minute', now())
      from public.ops_events e
      join due d on d.kind = e.kind and d.org_id is not distinct from e.org_id
     where e.alerted_at is null
       and e.minute < date_trunc('minute', now())
     group by e.kind, e.org_id;
$$;

-- After the email went out: stamps the unsent events (of minutes before
-- p_cutoff) of the groups claimed with p_stamp. Returns the rows stamped.
create function public.mark_ops_alerts_sent(p_stamp timestamptz, p_cutoff timestamptz)
returns integer
language sql
set search_path = ''
as $$
    with marked as (
        update public.ops_events e
           set alerted_at = p_stamp
          from public.ops_alert_state s
         where s.last_alerted_at = p_stamp
           and e.kind = s.kind
           and e.org_id is not distinct from s.org_id
           and e.alerted_at is null
           and e.minute < p_cutoff
        returning 1
    )
    select count(*)::int from marked;
$$;

-- After a failed send: frees the groups (or the daily summary) claimed with
-- p_stamp, so the next run tries again. Returns the groups freed.
create function public.release_ops_alerts(p_stamp timestamptz)
returns integer
language sql
set search_path = ''
as $$
    with released as (
        update public.ops_alert_state
           set last_alerted_at = '-infinity'
         where last_alerted_at = p_stamp
        returning 1
    )
    select count(*)::int from released;
$$;

-- The daily summary is sent once per period: returns the claim's stamp when it
-- was not sent since p_since, else null.
create function public.claim_ops_daily_summary(p_since timestamptz)
returns timestamptz
language sql
set search_path = ''
as $$
    insert into public.ops_alert_state as s (kind, org_id, last_alerted_at)
    values ('daily_summary', null, now())
    on conflict (kind, org_id) do update
        set last_alerted_at = excluded.last_alerted_at
        where s.last_alerted_at < p_since
    returning s.last_alerted_at;
$$;

-- Totals per kind and org of the events last seen since p_since, with the part
-- not emailed yet.
create function public.ops_events_summary(p_since timestamptz)
returns table (kind text, org_id uuid, events bigint, unsent bigint)
language sql
stable
set search_path = ''
as $$
    select e.kind, e.org_id, sum(e.count)::bigint,
           coalesce(sum(e.count) filter (where e.alerted_at is null), 0)::bigint
      from public.ops_events e
     where e.last_at >= p_since
     group by e.kind, e.org_id;
$$;

-- Queue jobs the database gave up on (claim_queue_jobs fails a job stranded in
-- 'processing' once its retries are used up; no application code sees that)
-- become queue_job_failed events, each job once: its error_message is marked
-- as reported. Returns the jobs reported.
create function public.report_stale_queue_failures()
returns integer
language sql
set search_path = ''
as $$
    with noted as (
        update public.message_queue q
           set error_message = 'Reclaimed from stale processing (reported)'
         where q.status = 'failed'
           and q.error_message = 'Reclaimed from stale processing'
        returning q.org_id
    ),
    per_org as (
        select n.org_id, count(*)::int as jobs from noted n group by n.org_id
    ),
    recorded as (
        insert into public.ops_events as e (kind, org_id, minute, first_at, last_at, count, detail)
        select 'queue_job_failed', p.org_id, date_trunc('minute', now()), now(), now(), p.jobs,
               format('%s pesan: worker berhenti di tengah proses, lalu batas percobaan habis', p.jobs)
          from per_org p
        on conflict (kind, org_id, minute) where alerted_at is null
        do update set count = e.count + excluded.count,
                      last_at = excluded.last_at,
                      detail = case when e.detail = '' then excluded.detail else e.detail end
        returning 1
    )
    select coalesce(sum(p.jobs), 0)::int from per_org p;
$$;

create function public.cleanup_old_ops_events()
returns void
language sql
set search_path = ''
as $$
    delete from public.ops_events where minute < now() - interval '30 days';
    delete from public.ops_alert_state where last_alerted_at < now() - interval '30 days';
$$;

revoke execute on function public.record_ops_event(text, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.claim_ops_alerts(integer) from public, anon, authenticated;
revoke execute on function public.mark_ops_alerts_sent(timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.release_ops_alerts(timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_ops_daily_summary(timestamptz) from public, anon, authenticated;
revoke execute on function public.ops_events_summary(timestamptz) from public, anon, authenticated;
revoke execute on function public.report_stale_queue_failures() from public, anon, authenticated;
revoke execute on function public.cleanup_old_ops_events() from public, anon, authenticated;
grant execute on function public.record_ops_event(text, uuid, text, integer) to service_role;
grant execute on function public.claim_ops_alerts(integer) to service_role;
grant execute on function public.mark_ops_alerts_sent(timestamptz, timestamptz) to service_role;
grant execute on function public.release_ops_alerts(timestamptz) to service_role;
grant execute on function public.claim_ops_daily_summary(timestamptz) to service_role;
grant execute on function public.ops_events_summary(timestamptz) to service_role;
grant execute on function public.report_stale_queue_failures() to service_role;
grant execute on function public.cleanup_old_ops_events() to service_role;
