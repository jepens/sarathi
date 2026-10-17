-- ops_events (0070; tracker 3.5, owner decision 2026-10-18): the events the
-- team is emailed about. Service role only: RLS on, one deny policy, no table
-- or sequence privilege for anon or authenticated; the cleanup function runs
-- for the service role only and deletes exactly the rows older than 30 days;
-- kind and detail are checked so a writer cannot store free text in kind or a
-- long payload in detail.
begin;
select plan(12);

select ok(
    (select relrowsecurity from pg_class where oid = 'public.ops_events'::regclass),
    'ops_events has RLS enabled');
select ok(
    not has_table_privilege('authenticated', 'public.ops_events',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'authenticated holds no table privilege on ops_events');
select ok(
    not has_table_privilege('anon', 'public.ops_events',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'anon holds no table privilege on ops_events');
select ok(
    not has_sequence_privilege('authenticated', 'public.ops_events_id_seq', 'USAGE, SELECT, UPDATE')
    and not has_sequence_privilege('anon', 'public.ops_events_id_seq', 'USAGE, SELECT, UPDATE'),
    'neither holds a privilege on its sequence');
select ok(
    has_table_privilege('service_role', 'public.ops_events', 'SELECT')
    and has_table_privilege('service_role', 'public.ops_events', 'INSERT')
    and has_table_privilege('service_role', 'public.ops_events', 'UPDATE')
    and has_table_privilege('service_role', 'public.ops_events', 'DELETE'),
    'the service role reads and writes it');
select is(
    (select string_agg(format('%s | %s | %s | %s', policyname, cmd,
                              array_to_string(array(select unnest(roles) order by 1), ','),
                              coalesce(qual, '-')), '; ')
       from pg_policies where schemaname = 'public' and tablename = 'ops_events'),
    'service_role only | ALL | anon,authenticated | false',
    'the only policy on ops_events is the service-role-only deny policy');
select ok(
    not has_function_privilege('anon', 'public.cleanup_old_ops_events()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.cleanup_old_ops_events()', 'EXECUTE'),
    'neither anon nor authenticated can run cleanup_old_ops_events');
select ok(
    has_function_privilege('service_role', 'public.cleanup_old_ops_events()', 'EXECUTE'),
    'the service role runs cleanup_old_ops_events');
select throws_ok(
    $$ insert into public.ops_events (kind) values ('Bad Kind') $$,
    '23514', null,
    'a kind outside [a-z][a-z0-9_] is refused');
select throws_ok(
    format('insert into public.ops_events (kind, detail) values (%L, %L)', 'webhook_error', repeat('x', 501)),
    '23514', null,
    'a detail over 500 characters is refused');

insert into public.ops_events (kind, created_at) values
    ('tst_cleanup', now() - interval '31 days'),
    ('tst_cleanup', now() - interval '29 days');
select public.cleanup_old_ops_events();
select is(
    (select count(*)::int from public.ops_events where kind = 'tst_cleanup' and created_at < now() - interval '30 days'),
    0,
    'the cleanup deletes events older than 30 days');
select is(
    (select count(*)::int from public.ops_events where kind = 'tst_cleanup'),
    1,
    'and keeps the newer ones');

select * from finish();
rollback;
