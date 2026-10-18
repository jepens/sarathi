-- Tracker 3.4 (minimal version, part of the tenant-2 gate): per-org quotas on
-- the WhatsApp AI path. Owner decision 2026-10-18 ("Sedang", D22): per org, at
-- most 30 new AI bursts a minute (the webhook counts a text that opens a chat's
-- AI burst; a fragment that joins the chat's burst still waiting in the queue
-- and a redelivery are not counted) and at most 300 AI replies a day
-- (Asia/Jakarta day; one unit per burst with a message not counted before: a
-- plain retry is free, but a message that joins a failing burst counts again,
-- so during an outage the units can run ahead of the replies delivered); at
-- 80% of the daily quota the team is warned, at the limit the AI stops (hard
-- stop) and the team is alerted (ops_events, 0070); the team can change the
-- limits of one org.
--
-- public.org_usage_counters: one row per (org, metric, window). The window of
-- 'inbound_minute' is the current minute, the window of 'ai_reply_day' the
-- current day in Asia/Jakarta. used counts the calls let through, refused the
-- calls refused once the limit was reached, refused_streak the refusals since
-- the last call let through. The first refusal after a call let through
-- (first_refusal) is alerted: once per window, and again when the team raised
-- the limit and the org reached the new one.
--
-- public.org_quota_overrides: the team's limits for one org; a null column
-- keeps the default, which the caller passes (lib/quota/org-quota.ts);
-- updated_at follows every change (set_updated_at trigger). Not in
-- app_settings: every member of an org can write that table ("org members full
-- access"), so a tenant could raise its own quota there.
--
-- public.message_queue.ai_quota_counted: whether a queued message was already
-- counted against the day window. The queue counts a burst when it holds a job
-- not counted before (its first attempt, a message that joined it after a
-- failure, or a burst a crashed worker claimed but never counted) and marks
-- the burst's jobs; a plain retry of a counted burst is not counted again. Old
-- code ignores the column (default false), so adding it is an expand.
--
-- consume_org_quota(org, metric, default_limit) counts one call against the
-- current window and says whether it is within the limit. Atomic under
-- concurrency: the increment is one INSERT ... ON CONFLICT DO UPDATE guarded by
-- "used < limit", which locks the row and checks the guard on its latest
-- version, so two callers can never both take the last unit.
-- cleanup_old_usage_counters() deletes minute windows older than one day and
-- day windows older than 90 days (kept for reviewing usage), hourly with the
-- other cleanups.
--
-- Service role only, like ops_events (0070) and whatsapp_integrations (0069):
-- RLS on, a deny policy, no table privilege for anon or authenticated
-- (message_queue and rate_limits carry the same deny policy but still grant
-- authenticated its table privileges); the functions are executable by the
-- service role only.
--
-- Expand: nothing uses these objects before the PR that ships them is
-- deployed; applied after 0070 and after the owner's review (D1).
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

create table public.org_usage_counters (
    org_id uuid not null references public.organizations (id) on delete cascade,
    metric text not null,
    window_start timestamptz not null,
    used integer not null default 0,
    refused integer not null default 0,
    refused_streak integer not null default 0,
    primary key (org_id, metric, window_start),
    constraint org_usage_counters_metric_check check (metric in ('inbound_minute', 'ai_reply_day'))
);

-- The primary key leads with org_id, so it covers the foreign key. The cleanup
-- deletes by metric and window start.
create index org_usage_counters_metric_window_idx on public.org_usage_counters (metric, window_start);

create table public.org_quota_overrides (
    org_id uuid primary key references public.organizations (id) on delete cascade,
    inbound_per_minute integer,
    ai_replies_per_day integer,
    note text not null default '',
    updated_at timestamptz not null default now(),
    constraint org_quota_overrides_inbound_check check (inbound_per_minute > 0),
    constraint org_quota_overrides_ai_check check (ai_replies_per_day > 0),
    constraint org_quota_overrides_note_check check (char_length(note) <= 500)
);

alter table public.message_queue add column ai_quota_counted boolean not null default false;

alter table public.org_usage_counters enable row level security;
alter table public.org_quota_overrides enable row level security;
revoke all on table public.org_usage_counters from anon, authenticated;
revoke all on table public.org_quota_overrides from anon, authenticated;
create policy "service_role only" on public.org_usage_counters
    as permissive for all to anon, authenticated
    using (false) with check (false);
create policy "service_role only" on public.org_quota_overrides
    as permissive for all to anon, authenticated
    using (false) with check (false);

create trigger trg_org_quota_overrides_updated_at
    before update on public.org_quota_overrides
    for each row execute function public.set_updated_at();

create function public.consume_org_quota(p_org uuid, p_metric text, p_default_limit integer)
returns table (allowed boolean, used integer, refused integer, quota integer, first_refusal boolean)
language plpgsql
set search_path = ''
as $$
declare
    v_window timestamptz;
    v_limit integer;
    v_used integer;
    v_refused integer;
    v_streak integer;
begin
    if p_org is null then
        raise exception 'consume_org_quota: p_org is required' using errcode = '22004';
    end if;
    if p_default_limit is null or p_default_limit < 1 then
        raise exception 'consume_org_quota: p_default_limit must be at least 1' using errcode = '22023';
    end if;
    v_window := case p_metric
        when 'inbound_minute' then date_trunc('minute', now())
        when 'ai_reply_day' then date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta'
    end;
    if v_window is null then
        raise exception 'consume_org_quota: unknown metric %', p_metric using errcode = '22023';
    end if;

    select case p_metric when 'inbound_minute' then o.inbound_per_minute else o.ai_replies_per_day end
      into v_limit
      from public.org_quota_overrides o
     where o.org_id = p_org;
    v_limit := coalesce(v_limit, p_default_limit);

    insert into public.org_usage_counters as c (org_id, metric, window_start, used)
    values (p_org, p_metric, v_window, 1)
    on conflict (org_id, metric, window_start) do update
        set used = c.used + 1,
            refused_streak = 0
        where c.used < v_limit
    returning c.used, c.refused into v_used, v_refused;
    if found then
        return query select true, v_used, v_refused, v_limit, false;
        return;
    end if;

    update public.org_usage_counters c
       set refused = c.refused + 1,
           refused_streak = c.refused_streak + 1
     where c.org_id = p_org and c.metric = p_metric and c.window_start = v_window
    returning c.used, c.refused, c.refused_streak into v_used, v_refused, v_streak;
    return query select false, v_used, v_refused, v_limit, v_streak = 1;
end;
$$;
revoke execute on function public.consume_org_quota(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.consume_org_quota(uuid, text, integer) to service_role;

create function public.cleanup_old_usage_counters()
returns void
language sql
set search_path = ''
as $$
    delete from public.org_usage_counters
     where (metric = 'inbound_minute' and window_start < now() - interval '1 day')
        or (metric = 'ai_reply_day' and window_start < now() - interval '90 days');
$$;
revoke execute on function public.cleanup_old_usage_counters() from public, anon, authenticated;
grant execute on function public.cleanup_old_usage_counters() to service_role;
