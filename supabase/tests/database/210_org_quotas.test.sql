-- Per-org quotas (0071; tracker 3.4, owner decision 2026-10-18 "Sedang").
-- Both tables are for the service role only (RLS on, one deny policy each, no
-- table privilege for anon or authenticated), so an org member can neither
-- read the counters nor raise its own quota, and only the service role runs
-- the functions. consume_org_quota counts the calls let through up to the
-- limit (used) and the refused ones after it (refused); first_refusal marks the
-- first refusal after a call let through (the alerted one: once per window, and
-- again after a raised limit is reached), per org, metric and window; an
-- override row changes the limit at once and a null column keeps the default; the minute
-- window is the current minute and the day window starts at 00:00 WIB. The
-- cleanup deletes minute windows older than a day and day windows older than
-- 90 days.
begin;
select plan(35);

select tests.create_two_orgs();

select ok(
    (select relrowsecurity from pg_class where oid = 'public.org_usage_counters'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.org_quota_overrides'::regclass),
    'both quota tables have RLS enabled');
select ok(
    not has_table_privilege('authenticated', 'public.org_usage_counters',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    and not has_table_privilege('authenticated', 'public.org_quota_overrides',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'authenticated holds no table privilege on either');
select ok(
    not has_table_privilege('anon', 'public.org_usage_counters',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    and not has_table_privilege('anon', 'public.org_quota_overrides',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'anon holds no table privilege on either');
select ok(
    has_table_privilege('service_role', 'public.org_usage_counters', 'SELECT')
    and has_table_privilege('service_role', 'public.org_usage_counters', 'INSERT')
    and has_table_privilege('service_role', 'public.org_usage_counters', 'UPDATE')
    and has_table_privilege('service_role', 'public.org_usage_counters', 'DELETE')
    and has_table_privilege('service_role', 'public.org_quota_overrides', 'SELECT')
    and has_table_privilege('service_role', 'public.org_quota_overrides', 'INSERT')
    and has_table_privilege('service_role', 'public.org_quota_overrides', 'UPDATE')
    and has_table_privilege('service_role', 'public.org_quota_overrides', 'DELETE'),
    'the service role reads and writes both');
select is(
    (select string_agg(format('%s | %s | %s | %s | %s', tablename, policyname, cmd,
                              array_to_string(array(select unnest(roles) order by 1), ','),
                              coalesce(qual, '-')), '; ' order by tablename)
       from pg_policies
      where schemaname = 'public' and tablename in ('org_usage_counters', 'org_quota_overrides')),
    'org_quota_overrides | service_role only | ALL | anon,authenticated | false; '
    || 'org_usage_counters | service_role only | ALL | anon,authenticated | false',
    'the only policy on each is the service-role-only deny policy');
select ok(
    not has_function_privilege('anon', 'public.consume_org_quota(uuid, text, integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.consume_org_quota(uuid, text, integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.cleanup_old_usage_counters()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.cleanup_old_usage_counters()', 'EXECUTE'),
    'neither anon nor authenticated can run the quota functions');
select ok(
    has_function_privilege('service_role', 'public.consume_org_quota(uuid, text, integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.cleanup_old_usage_counters()', 'EXECUTE'),
    'the service role runs both');

-- An org owner, signed in: refused by the privilege checks.
select tests.authenticate_as(tests.user_a1());
select throws_ok(
    format('select * from public.consume_org_quota(%L, %L, 10)', tests.org_a(), 'ai_reply_day'),
    '42501', 'permission denied for function consume_org_quota',
    'an org owner cannot call consume_org_quota');
select throws_ok(
    'select 1 from public.org_usage_counters',
    '42501', null,
    'an org owner cannot read the counters');
select throws_ok(
    format('insert into public.org_quota_overrides (org_id, ai_replies_per_day) values (%L, 100000)', tests.org_a()),
    '42501', null,
    'an org owner cannot raise its own quota');
select tests.clear_authentication();

-- Counting, as the service role (the caller in production).
select tests.authenticate_as_service_role();
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(t,1,0,3,f)',
    'the first call of a window is let through');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(t,2,0,3,f)',
    'the second too');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(t,3,0,3,f)',
    'the third takes the last unit');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(f,3,1,3,t)',
    'the fourth is refused: used stays at the limit, and it is the alerted first refusal');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(f,3,2,3,f)',
    'later refusals count on, without another alert');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_b(), 'inbound_minute', 3)),
    '(t,1,0,3,f)',
    'another org has its own counter');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'ai_reply_day', 300)),
    '(t,1,0,300,f)',
    'another metric has its own counter');

-- Overrides, written by the team with the service role.
insert into public.org_quota_overrides (org_id, inbound_per_minute, note, updated_at)
values (tests.org_a(), 5, 'tes', now() - interval '1 day');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(t,4,2,5,f)',
    'a raised limit applies at once, in the same window');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'ai_reply_day', 300)),
    '(t,2,0,300,f)',
    'a null override column keeps the default');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(t,5,2,5,f)',
    'up to the raised limit');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(f,5,3,5,t)',
    'reaching the raised limit is alerted again (the first refusal since a call let through)');
update public.org_quota_overrides set inbound_per_minute = 2 where org_id = tests.org_a();
select is(
    (select updated_at from public.org_quota_overrides where org_id = tests.org_a()),
    now(),
    'a change of the limits moves updated_at');
select is(
    (select row(allowed, used, refused, quota, first_refusal)::text from public.consume_org_quota(tests.org_a(), 'inbound_minute', 3)),
    '(f,5,4,2,f)',
    'a lowered limit refuses at once');

-- Windows.
select is(
    (select window_start from public.org_usage_counters where org_id = tests.org_b() and metric = 'inbound_minute'),
    date_trunc('minute', now()),
    'the minute window starts at the current minute');
select ok(
    (select extract(hour from window_start at time zone 'UTC') = 17
            and extract(minute from window_start at time zone 'UTC') = 0
            and window_start <= now() and now() - window_start < interval '1 day'
       from public.org_usage_counters where org_id = tests.org_a() and metric = 'ai_reply_day'),
    'the day window starts at 00:00 WIB (17:00 UTC) of the current Jakarta day');

-- The queue's per-job flag: a new message is not counted yet.
insert into public.message_queue (org_id, phone_number, message_text) values (tests.org_a(), '620000000009', 'baru');
select is(
    (select ai_quota_counted from public.message_queue where phone_number = '620000000009'),
    false,
    'a newly queued message is not counted against the day window yet');
-- claim_queue_jobs (0042, returns setof message_queue) hands the flag to the
-- queue worker, which counts only the jobs not counted before.
update public.message_queue
   set ai_quota_counted = true, created_at = now() - interval '5 minutes', updated_at = now() - interval '5 minutes'
 where phone_number = '620000000009';
select is(
    (select string_agg(format('%s:%s', message_text, ai_quota_counted), ',')
       from public.claim_queue_jobs(p_limit => 1000, p_stale_seconds => 600, p_debounce_seconds => 60)
      where phone_number = '620000000009'),
    'baru:t',
    'claim_queue_jobs returns ai_quota_counted to the queue worker');

-- Bad input.
select throws_ok(
    format('select * from public.consume_org_quota(%L, %L, 3)', tests.org_a(), 'tokens_month'),
    '22023', null,
    'an unknown metric is refused');
select throws_ok(
    format('select * from public.consume_org_quota(%L, %L, 0)', tests.org_a(), 'inbound_minute'),
    '22023', null,
    'a default limit below 1 is refused');
select throws_ok(
    $$ select * from public.consume_org_quota(null, 'inbound_minute', 3) $$,
    '22004', null,
    'a missing org is refused');
select throws_ok(
    format('insert into public.org_quota_overrides (org_id, ai_replies_per_day) values (%L, 0)', tests.org_b()),
    '23514', null,
    'an override below 1 is refused');
select throws_ok(
    format('insert into public.org_usage_counters (org_id, metric, window_start) values (%L, %L, now())',
           tests.org_b(), 'tokens_month'),
    '23514', null,
    'a counter of an unknown metric is refused');

-- Cleanup.
insert into public.org_usage_counters (org_id, metric, window_start) values
    (tests.org_b(), 'inbound_minute', date_trunc('minute', now()) - interval '25 hours'),
    (tests.org_b(), 'inbound_minute', date_trunc('minute', now()) - interval '23 hours'),
    (tests.org_b(), 'ai_reply_day', date_trunc('day', now()) - interval '91 days'),
    (tests.org_b(), 'ai_reply_day', date_trunc('day', now()) - interval '89 days');
select public.cleanup_old_usage_counters();
select is(
    (select count(*)::int from public.org_usage_counters
      where org_id = tests.org_b() and metric = 'inbound_minute' and window_start < now() - interval '1 day'),
    0,
    'the cleanup deletes minute windows older than one day');
select is(
    (select count(*)::int from public.org_usage_counters
      where org_id = tests.org_b() and metric = 'ai_reply_day' and window_start < now() - interval '90 days'),
    0,
    'and day windows older than 90 days');
select is(
    (select count(*)::int from public.org_usage_counters where org_id = tests.org_b()),
    3,
    'and keeps the newer ones (this minute, 23 hours ago, 89 days ago)');

select * from finish();
rollback;
