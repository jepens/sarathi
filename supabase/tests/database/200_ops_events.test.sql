-- ops_events and ops_alert_state (0070; tracker 3.5, owner decision
-- 2026-10-18): the events the team is emailed about. Service role only: RLS
-- on, one deny policy each, no table or sequence privilege for anon or
-- authenticated, every function for the service role only. record_ops_event
-- keeps one row per kind, org and minute; claim_ops_alerts claims per (kind,
-- org) the groups with unsent events of finished minutes that were not emailed
-- within the cooldown, never the same group twice; mark_ops_alerts_sent stamps
-- only the claimed groups' events; release_ops_alerts frees a claim after a
-- failed send; the daily summary is claimed once per period;
-- report_stale_queue_failures reports each job the stale-job reclaim failed
-- once; the cleanup keeps 30 days.
begin;
select plan(40);

select tests.create_two_orgs();

-- Lockdown.
select ok(
    (select relrowsecurity from pg_class where oid = 'public.ops_events'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.ops_alert_state'::regclass),
    'both ops tables have RLS enabled');
select ok(
    not has_table_privilege('authenticated', 'public.ops_events',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    and not has_table_privilege('authenticated', 'public.ops_alert_state',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'authenticated holds no table privilege on either');
select ok(
    not has_table_privilege('anon', 'public.ops_events',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    and not has_table_privilege('anon', 'public.ops_alert_state',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'anon holds no table privilege on either');
select ok(
    not has_sequence_privilege('authenticated', 'public.ops_events_id_seq', 'USAGE, SELECT, UPDATE')
    and not has_sequence_privilege('anon', 'public.ops_events_id_seq', 'USAGE, SELECT, UPDATE')
    and not has_sequence_privilege('authenticated', 'public.ops_alert_state_id_seq', 'USAGE, SELECT, UPDATE')
    and not has_sequence_privilege('anon', 'public.ops_alert_state_id_seq', 'USAGE, SELECT, UPDATE'),
    'neither holds a privilege on their sequences');
select ok(
    has_table_privilege('service_role', 'public.ops_events', 'SELECT, INSERT, UPDATE, DELETE')
    and has_table_privilege('service_role', 'public.ops_alert_state', 'SELECT, INSERT, UPDATE, DELETE'),
    'the service role reads and writes both');
select is(
    (select string_agg(format('%s | %s | %s | %s | %s', tablename, policyname, cmd,
                              array_to_string(array(select unnest(roles) order by 1), ','),
                              coalesce(qual, '-')), '; ' order by tablename)
       from pg_policies where schemaname = 'public' and tablename in ('ops_events', 'ops_alert_state')),
    'ops_alert_state | service_role only | ALL | anon,authenticated | false; '
    || 'ops_events | service_role only | ALL | anon,authenticated | false',
    'the only policy on each is the service-role-only deny policy');
select is(
    (select string_agg(p.oid::regprocedure::text, ', ' order by p.proname)
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('record_ops_event', 'claim_ops_alerts', 'mark_ops_alerts_sent', 'release_ops_alerts',
                          'claim_ops_daily_summary', 'ops_events_summary', 'report_stale_queue_failures',
                          'cleanup_old_ops_events')
        and (has_function_privilege('anon', p.oid, 'EXECUTE')
             or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
    null,
    'anon and authenticated can run none of the ops functions');
select is(
    (select count(*)::int
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('record_ops_event', 'claim_ops_alerts', 'mark_ops_alerts_sent', 'release_ops_alerts',
                          'claim_ops_daily_summary', 'ops_events_summary', 'report_stale_queue_failures',
                          'cleanup_old_ops_events')
        and has_function_privilege('service_role', p.oid, 'EXECUTE')),
    8,
    'the service role runs all eight');

select tests.authenticate_as(tests.user_a1());
select throws_ok(
    $$ select public.record_ops_event('tst_x', null, 'x', 1) $$,
    '42501', 'permission denied for function record_ops_event',
    'an org owner cannot record an event');
select throws_ok(
    $$ select * from public.claim_ops_alerts(3600) $$,
    '42501', 'permission denied for function claim_ops_alerts',
    'nor claim alerts');
select tests.clear_authentication();

-- Recording, as the service role.
select tests.authenticate_as_service_role();
select public.record_ops_event('tst_now', tests.org_a(), 'pertama', 1);
select public.record_ops_event('tst_now', tests.org_a(), 'kedua', 3);
select public.record_ops_event('tst_now', tests.org_a(), '', 0);
select public.record_ops_event('tst_now', null, repeat('x', 600), null);
select public.record_ops_event('tst_now', null, 'lagi', 2);
select is(
    (select count from public.ops_events where kind = 'tst_now' and org_id = tests.org_a()),
    5,
    'events of the same kind, org and minute add up in one row (a count below 1 counts as 1)');
select is(
    (select detail from public.ops_events where kind = 'tst_now' and org_id = tests.org_a()),
    'pertama',
    'the row keeps the first example detail');
select is(
    (select count(*)::int from public.ops_events where kind = 'tst_now'),
    2,
    'another org (here: none) gets its own row');
select is(
    (select count from public.ops_events where kind = 'tst_now' and org_id is null),
    3,
    'events without an org add up in one row too (nulls not distinct)');
select is(
    (select char_length(detail) from public.ops_events where kind = 'tst_now' and org_id is null),
    500,
    'a long detail is cut to 500 characters');
select throws_ok(
    $$ select public.record_ops_event('Bad Kind', null, '', 1) $$,
    '23514', null,
    'a kind outside [a-z][a-z0-9_] is refused');

-- Claiming. Events of closed minutes, and the state of two groups: one
-- emailed 30 minutes ago (cooling), one 2 hours ago (due again). The claimed
-- group tst_due also has a row of the previous minute (not closed yet: a
-- writer may still be adding to it) and one of the current minute.
insert into public.ops_events (kind, org_id, minute, first_at, last_at, count, detail) values
    ('tst_due', tests.org_a(), date_trunc('minute', now()) - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes', 2, 'd1'),
    ('tst_due', tests.org_a(), date_trunc('minute', now()) - interval '4 minutes', now() - interval '4 minutes', now() - interval '4 minutes', 1, 'd2'),
    ('tst_due', tests.org_a(), date_trunc('minute', now()) - interval '3 minutes', now() - interval '3 minutes', now() - interval '3 minutes', 1, 'd3'),
    ('tst_due', tests.org_a(), date_trunc('minute', now()) - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes', 1, 'd4'),
    ('tst_noorg', null, date_trunc('minute', now()) - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes', 4, ''),
    ('tst_cool', tests.org_a(), date_trunc('minute', now()) - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes', 1, 'c'),
    ('tst_cool', tests.org_b(), date_trunc('minute', now()) - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes', 6, 'c'),
    ('tst_due', tests.org_a(), date_trunc('minute', now()) - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute', 1, 'tepi');
select public.record_ops_event('tst_due', tests.org_a(), 'baru', 7);
insert into public.ops_alert_state (kind, org_id, last_alerted_at) values
    ('tst_cool', tests.org_a(), now() - interval '30 minutes'),
    ('tst_cool', tests.org_b(), now() - interval '2 hours');

create temp table claimed on commit drop as select * from public.claim_ops_alerts(3600);
select is(
    (select string_agg(format('%s/%s=%s', kind, coalesce(org_id::text, '-'), events), ', ' order by kind, org_id nulls first)
       from claimed),
    format('tst_cool/%s=6, tst_due/%s=5, tst_noorg/-=4', tests.org_b(), tests.org_a()),
    'the claim takes, per kind and org, the groups with unsent events of closed minutes not emailed in the last hour');
select is(
    (select cardinality(details) from claimed where kind = 'tst_due'),
    3,
    'with at most three example details');
select is(
    (select details from claimed where kind = 'tst_noorg'),
    null::text[],
    'and none when the examples are empty');
select ok(
    (select bool_and(stamp = now() and cutoff = date_trunc('minute', now()) - interval '1 minute') from claimed),
    'every row carries the claim stamp and the cutoff (the start of the previous minute)');
select is(
    (select count(*)::int from public.ops_alert_state where last_alerted_at = now()),
    3,
    'the state rows of the claimed groups carry the stamp');
select is(
    (select count(*)::int from public.ops_events where alerted_at is not null),
    0,
    'the claim stamps no event: that waits until the email is out');
select is(
    (select count(*)::int from public.claim_ops_alerts(3600)),
    0,
    'a second, overlapping claim gets none of the claimed groups');

-- Marking after the email went out.
select is(
    public.mark_ops_alerts_sent(now(), date_trunc('minute', now()) - interval '1 minute'),
    6,
    'marking stamps the unsent rows of closed minutes of the claimed groups');
select is(
    (select string_agg(kind || '/' || coalesce(org_id::text, '-'), ', ' order by kind, org_id nulls first)
       from public.ops_events where alerted_at is null and kind <> 'tst_due'),
    format('tst_cool/%s, tst_now/-, tst_now/%s', tests.org_a(), tests.org_a()),
    'the cooling group and the current minute stay unsent');
select is(
    (select string_agg(format('%s=%s', (extract(epoch from minute - date_trunc('minute', now())) / 60)::int, count), ', ' order by minute)
       from public.ops_events where kind = 'tst_due' and alerted_at is null),
    '-1=1, 0=7',
    'a claimed group keeps its rows of the previous and the current minute: neither counted in the email nor stamped');

-- Releasing after a failed send.
insert into public.ops_events (kind, org_id, minute, first_at, last_at, count, detail) values
    ('tst_retry', tests.org_a(), date_trunc('minute', now()) - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes', 1, 'r');
select is(
    (select string_agg(kind, ',') from public.claim_ops_alerts(3600)),
    'tst_retry',
    'a new group is claimed');
select is(
    public.release_ops_alerts(now()),
    4,
    'a failed send releases every group claimed with that stamp');
select is(
    (select string_agg(kind, ',') from public.claim_ops_alerts(3600)),
    'tst_retry',
    'so the next run claims the released group again (its events were never marked)');

-- The daily summary.
select ok(
    public.claim_ops_daily_summary(now() - interval '1 day') = now(),
    'the daily summary is claimed once per period');
select is(
    public.claim_ops_daily_summary(now() - interval '1 day'),
    null,
    'and not twice');
select is(
    (select string_agg(format('%s/%s=%s/%s', kind, coalesce(org_id::text, '-'), events, unsent), ', '
                       order by kind, org_id nulls first)
       from public.ops_events_summary(now() - interval '1 day') where kind like 'tst%'),
    format('tst_cool/%1$s=1/1, tst_cool/%2$s=6/0, tst_due/%1$s=13/8, tst_noorg/-=4/0, tst_now/-=3/3, tst_now/%1$s=5/5, tst_retry/%1$s=1/1',
           tests.org_a(), tests.org_b()),
    'the summary gives totals per kind and org with the part not emailed');

-- Queue jobs the stale-job reclaim failed.
insert into public.message_queue (org_id, phone_number, message_text, status, retries, max_retries, error_message, processed_at) values
    (tests.org_a(), '620000000001', 'x', 'failed', 3, 3, 'Reclaimed from stale processing', now()),
    (tests.org_a(), '620000000001', 'x2', 'failed', 3, 3, 'Reclaimed from stale processing', now()),
    (tests.org_a(), '620000000002', 'y', 'failed', 3, 3, 'Reclaimed from stale processing', now()),
    (tests.org_a(), '620000000003', 'z', 'failed', 3, 3, 'OpenAI 500', now()),
    (tests.org_a(), '620000000004', 'w', 'pending', 1, 3, 'Reclaimed from stale processing', null);
select is(
    public.report_stale_queue_failures(),
    3,
    'queue jobs failed by the stale-job reclaim are reported; other failures and retryable reclaims are not');
select is(
    (select format('%s | %s', count, detail) from public.ops_events
      where kind = 'queue_job_failed' and org_id = tests.org_a() and alerted_at is null),
    '2 | 3 pesan dari 2 percakapan: worker berhenti di tengah proses, lalu batas percobaan habis',
    'as one queue_job_failed row counting conversations, like the application path');
select is(
    (select error_message from public.message_queue where phone_number = '620000000004'),
    'Reclaimed from stale processing',
    'a retryable reclaim (still pending) is left alone');
select is(
    public.report_stale_queue_failures(),
    0,
    'each job only once');

-- Cleanup.
insert into public.ops_events (kind, org_id, minute, first_at, last_at, count) values
    ('tst_old', null, now() - interval '31 days', now() - interval '31 days', now() - interval '31 days', 1),
    ('tst_old', null, now() - interval '29 days', now() - interval '29 days', now() - interval '29 days', 1);
insert into public.ops_alert_state (kind, org_id, last_alerted_at) values ('tst_old', null, now() - interval '31 days');
select public.cleanup_old_ops_events();
select is(
    (select count(*)::int from public.ops_events where kind = 'tst_old'),
    1,
    'the cleanup deletes events older than 30 days and keeps the newer');
select is(
    (select count(*)::int from public.ops_alert_state where kind = 'tst_old' or last_alerted_at = '-infinity'),
    0,
    'and state older than 30 days, released state included');

-- Column checks.
select throws_ok(
    $$ insert into public.ops_events (kind, minute, first_at, last_at, count) values ('tst_x', now(), now(), now(), 0) $$,
    '23514', null,
    'a count below 1 is refused');
select throws_ok(
    format('insert into public.ops_events (kind, minute, first_at, last_at, detail) values (%L, now(), now(), now(), %L)',
           'tst_x', repeat('x', 501)),
    '23514', null,
    'a detail over 500 characters is refused');

select * from finish();
rollback;
