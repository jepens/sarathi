-- Atomic inbound ingest (0072; tracker 2.2a part 2, PR-C2, owner decisions
-- D23). wa_ingest_inbound writes one inbound WhatsApp message per call, in one
-- transaction, under a per-contact advisory lock: contact key, redelivery
-- gate, rate limit (fails open), chat row, message row, chat summary from
-- Meta's time (forward only), BSUID, work row, AI decision and queue job.
-- wa_apply_statuses applies the statuses of one webhook change forward only,
-- on the org's assistant rows. claim_inbound_work and cleanup_old_inbound_work
-- serve the durable follow-up work (callers from PR-C3).
--
-- Every call runs as the service role, the webhook's role. A race between two
-- deliveries cannot be staged in one session, so temporary triggers (created
-- and dropped here, and rolled back anyway) write what the other delivery
-- would have written at that point, or make a step fail on purpose.
--   1. catalog and grants          7. AI decision and quota
--   2. parameters, no identity     8. identity, realtime broadcasts
--   3. a failed call leaves        9. statuses
--      nothing; the retry works   10. work rows
--   4. a late resend changes      11. members and anon
--      nothing; late statuses
--   5. chat summary
--   6. rate limit
begin;
select plan(126);

select tests.create_two_orgs();

-- ---------------------------------------------------------------------------
-- Helpers (as postgres)
-- ---------------------------------------------------------------------------

-- Results of the calls, snapshots and realtime marks, by label.
create table tests._220_res (label text primary key, res jsonb not null);
grant select, insert on tests._220_res to service_role;

-- One ingest call with test defaults, recorded under p_label.
create function tests._220_in(
    p_label text,
    p_org uuid,
    p_from text,
    p_wamid text,
    p_bsuid text default null,
    p_wa_ts timestamptz default null,
    p_preview text default 'halo',
    p_unread boolean default true,
    p_rate_scope text default null,
    p_rate_max integer default 10,
    p_ai_eligible boolean default false,
    p_inbound_limit integer default 30,
    p_queue_text text default 'halo',
    p_work_kind text default null,
    p_work_payload jsonb default null,
    p_verified_phone text default null,
    p_metadata jsonb default '{}'::jsonb,
    p_media_type text default null)
returns void
language sql
as $$
    insert into tests._220_res (label, res)
    select p_label, to_jsonb(r)
      from public.wa_ingest_inbound(
               p_org => p_org, p_from => p_from, p_bsuid => p_bsuid, p_wamid => p_wamid,
               p_wa_ts => p_wa_ts, p_content => p_preview, p_preview => p_preview,
               p_verified_phone => p_verified_phone, p_reply_to_wamid => null,
               p_media_type => p_media_type, p_media_mime => null, p_media_filename => null,
               p_metadata => p_metadata, p_unread => p_unread, p_rate_scope => p_rate_scope,
               p_rate_max => p_rate_max, p_ai_eligible => p_ai_eligible,
               p_queue_text => p_queue_text, p_inbound_limit => p_inbound_limit,
               p_work_kind => p_work_kind, p_work_payload => p_work_payload) r;
$$;

-- One statuses call, recorded under p_label.
create function tests._220_st(p_label text, p_org uuid, p_statuses jsonb)
returns void
language sql
as $$
    insert into tests._220_res (label, res)
    select p_label, to_jsonb(r) from public.wa_apply_statuses(p_org, p_statuses) r;
$$;

-- One claim, recorded under p_label as a JSON array of the returned rows.
create function tests._220_claim(p_label text, p_limit integer, p_lease integer, p_id uuid default null)
returns void
language sql
as $$
    insert into tests._220_res (label, res)
    select p_label, coalesce(jsonb_agg(to_jsonb(w)), '[]'::jsonb)
      from public.claim_inbound_work(p_limit, p_lease, p_id) w;
$$;

create function tests._220_r(p_label text)
returns jsonb
language sql
stable
as $$
    select r.res from tests._220_res r where r.label = p_label;
$$;

-- The named fields of a recorded result, '/'-separated, '-' for null.
create function tests._220_f(p_label text, variadic p_keys text[])
returns text
language sql
stable
as $$
    select string_agg(coalesce(r.res ->> k.key, '-'), '/' order by k.n)
      from tests._220_res r
      cross join unnest(p_keys) with ordinality as k(key, n)
     where r.label = p_label;
$$;

-- Realtime: remember the ids of the org topics' messages so far, then list
-- the messages sent since ('<event> <op>', sorted). Messages are told apart
-- by id, not by time (see 150). SECURITY DEFINER: postgres reads
-- realtime.messages whatever role the test runs as.
create function tests._220_bus_mark(p_label text)
returns void
language sql
security definer
set search_path = ''
as $$
    insert into tests._220_res (label, res)
    select p_label, coalesce(jsonb_agg(m.id::text), '[]'::jsonb)
      from realtime.messages m
     where m.topic in ('org:' || tests.org_a()::text, 'org:' || tests.org_b()::text);
$$;

create function tests._220_bus_since(p_label text)
returns text[]
language sql
security definer
set search_path = ''
as $$
    select coalesce(array_agg(m.event || ' ' || (m.payload ->> 'op') order by m.event, m.payload ->> 'op'), '{}')
      from realtime.messages m
     where m.topic in ('org:' || tests.org_a()::text, 'org:' || tests.org_b()::text)
       and not exists (select 1
                         from tests._220_res r
                         cross join jsonb_array_elements_text(r.res) as s(id)
                        where r.label = p_label and s.id = m.id::text);
$$;

-- Whether this session holds the ingest's advisory lock of (org, key): a
-- bigint key shows as classid (high half), objid (low half), objsubid 1.
create function tests._220_lock_held(p_org uuid, p_key text)
returns boolean
language sql
stable
as $$
    select exists (
        select 1
          from pg_catalog.pg_locks l
          cross join (select pg_catalog.hashtextextended('wa_ingest:' || p_org::text || ':' || p_key, 0) as v) k
         where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted
           and l.mode = 'ExclusiveLock' and l.objsubid = 1
           and l.classid = ((k.v >> 32) & 4294967295)::oid
           and l.objid = (k.v & 4294967295)::oid);
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Catalog and grants
-- ---------------------------------------------------------------------------

-- The webhook calls them with these exact names (lib/whatsapp/webhook). (name
-- columns have collation "C": compared as default-collation text)
select results_eq(
    $$ select p.proname::text collate "default",
              pg_get_function_identity_arguments(p.oid),
              replace(pg_get_function_result(p.oid), 'public.', '')
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('wa_ingest_inbound', 'wa_apply_statuses', 'claim_inbound_work',
                            'cleanup_old_inbound_work')
        order by 1 $$,
    $$ values
        ('claim_inbound_work', 'p_limit integer, p_lease_seconds integer, p_id uuid',
         'SETOF whatsapp_inbound_work'),
        ('cleanup_old_inbound_work', '', 'void'),
        ('wa_apply_statuses', 'p_org uuid, p_statuses jsonb',
         'TABLE(applied integer, stale integer, unknown integer, unknown_ids text[], '
         || 'bsuid_filled integer, bsuid_conflicts integer)'),
        ('wa_ingest_inbound',
         'p_org uuid, p_from text, p_bsuid text, p_wamid text, p_wa_ts timestamp with time zone, '
         || 'p_content text, p_preview text, p_verified_phone text, p_reply_to_wamid text, '
         || 'p_media_type text, p_media_mime text, p_media_filename text, p_metadata jsonb, '
         || 'p_unread boolean, p_rate_scope text, p_rate_max integer, p_ai_eligible boolean, '
         || 'p_queue_text text, p_inbound_limit integer, p_work_kind text, p_work_payload jsonb',
         'TABLE(outcome text, contact_key text, message_id uuid, chat_created boolean, '
         || 'summary_applied boolean, contact_name text, ai_enabled boolean, queue_outcome text, '
         || 'quota_limit integer, quota_first_refusal boolean, quota_error text, rate_first boolean, '
         || 'rate_error text, bsuid_conflict boolean, work_id uuid, work_state text)') $$,
    'the four functions have exactly the contract signatures');

select is(
    (select string_agg(p.proname || ':' || r.role, ', ' order by p.proname, r.role)
       from pg_proc p
       cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('wa_ingest_inbound', 'wa_apply_statuses', 'claim_inbound_work',
                          'cleanup_old_inbound_work')
        and has_function_privilege(r.role, p.oid, 'EXECUTE')),
    'claim_inbound_work:service_role, cleanup_old_inbound_work:service_role, '
    || 'wa_apply_statuses:service_role, wa_ingest_inbound:service_role',
    'only the service role can run the four functions (anon and authenticated cannot, PUBLIC included)');

select results_eq(
    $$ select p.proname::text collate "default", p.prosecdef, p.proconfig collate "default"
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('wa_ingest_inbound', 'wa_apply_statuses', 'claim_inbound_work',
                            'cleanup_old_inbound_work')
        order by 1 $$,
    $$ values ('claim_inbound_work', false, array['search_path=""']),
              ('cleanup_old_inbound_work', false, array['search_path=""']),
              ('wa_apply_statuses', false, array['search_path=""', 'lock_timeout=3s']),
              ('wa_ingest_inbound', false, array['search_path=""', 'lock_timeout=3s']) $$,
    'all four are SECURITY INVOKER with search_path pinned to the empty string; '
    || 'the ingest and the statuses wait at most 3 s for a lock');

select ok(
    (select relrowsecurity from pg_class where oid = 'public.whatsapp_inbound_work'::regclass),
    'whatsapp_inbound_work has RLS enabled');
select is(
    (select string_agg(format('%s | %s | %s | %s | %s | %s',
                              policyname, permissive, cmd,
                              array_to_string(array(select unnest(roles) order by 1), ','),
                              coalesce(qual, '-'), coalesce(with_check, '-')), '; ')
       from pg_policies
      where schemaname = 'public' and tablename = 'whatsapp_inbound_work'),
    'service_role only | PERMISSIVE | ALL | anon,authenticated | false | false',
    'the only policy on whatsapp_inbound_work is the service-role-only deny policy');
select ok(
    not has_table_privilege('authenticated', 'public.whatsapp_inbound_work',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    and not has_any_column_privilege('authenticated', 'public.whatsapp_inbound_work',
        'SELECT, INSERT, UPDATE, REFERENCES'),
    'authenticated holds no table or column privilege on whatsapp_inbound_work');
select ok(
    not has_table_privilege('anon', 'public.whatsapp_inbound_work',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    and not has_any_column_privilege('anon', 'public.whatsapp_inbound_work',
        'SELECT, INSERT, UPDATE, REFERENCES'),
    'anon holds no table or column privilege on whatsapp_inbound_work');
select ok(
    has_table_privilege('service_role', 'public.whatsapp_inbound_work', 'SELECT')
    and has_table_privilege('service_role', 'public.whatsapp_inbound_work', 'INSERT')
    and has_table_privilege('service_role', 'public.whatsapp_inbound_work', 'UPDATE')
    and has_table_privilege('service_role', 'public.whatsapp_inbound_work', 'DELETE'),
    'the service role reads and writes whatsapp_inbound_work');
select triggers_are('public', 'whatsapp_inbound_work', array['trg_whatsapp_inbound_work_updated_at'],
    'whatsapp_inbound_work has only its updated_at trigger (no realtime broadcast)');
select is(
    (select format('%s notnull=%s default=%s', format_type(a.atttypid, a.atttypmod), a.attnotnull,
                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-'))
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.whatsapp_messages'::regclass and a.attname = 'wa_timestamp'),
    'timestamp with time zone notnull=f default=-',
    'whatsapp_messages.wa_timestamp is a nullable timestamptz without a default (a catalog-only change)');

-- ---------------------------------------------------------------------------
-- 2. Parameters and missing identity (permanent errors for the webhook; the
--    texts name the parameter only, never a phone, BSUID or message text)
-- ---------------------------------------------------------------------------
select tests.authenticate_as_service_role();

select throws_ok(
    $$ select tests._220_in('v.x1', tests.org_a(), '620022000001', null) $$,
    '22004', 'wa_ingest_inbound: p_wamid must not be null',
    'a missing wamid is refused with 22004');
select throws_ok(
    $$ select tests._220_in('v.x2', null, '620022000001', 'wamid.220.v', p_preview => null) $$,
    '22004', 'wa_ingest_inbound: p_org, p_content, p_preview must not be null',
    'every missing parameter is named');
select throws_ok(
    $$ select tests._220_in('v.x3', tests.org_a(), '620022000001', 'wamid.220.v',
                            p_ai_eligible => true, p_queue_text => null) $$,
    '22004', 'wa_ingest_inbound: p_queue_text must not be null',
    'an AI-eligible message needs its queue text');
select throws_ok(
    $$ select tests._220_in('v.x4', tests.org_a(), '620022000001', '') $$,
    '22023', 'wa_ingest_inbound: p_wamid must not be empty',
    'an empty wamid is refused (it would make every later message without one a duplicate)');
select throws_ok(
    $$ select tests._220_in('v.x5', tests.org_a(), '620022000001', 'wamid.220.v', p_metadata => '[]') $$,
    '22023', 'wa_ingest_inbound: p_metadata must be a JSON object',
    'the metadata must be a JSON object');
select throws_ok(
    $$ select tests._220_in('v.x6', tests.org_a(), '620022000001', 'wamid.220.v', p_rate_scope => 'utama') $$,
    '22023', 'wa_ingest_inbound: p_rate_scope must be main, other or null',
    'the rate scope is main, other or null');
select throws_ok(
    $$ select tests._220_in('v.x7', tests.org_a(), '620022000001', 'wamid.220.v',
                            p_rate_scope => 'main', p_rate_max => 0) $$,
    '22023', 'wa_ingest_inbound: p_rate_max must be at least 1 with a rate scope',
    'a rate scope needs a limit of at least 1');
select throws_ok(
    $$ select tests._220_in('v.x8', tests.org_a(), '620022000001', 'wamid.220.v',
                            p_ai_eligible => true, p_inbound_limit => 0) $$,
    '22023', 'wa_ingest_inbound: p_inbound_limit must be at least 1 when AI-eligible',
    'an AI-eligible message needs an inbound limit of at least 1');
select throws_ok(
    $$ select tests._220_in('v.x9', tests.org_a(), '620022000001', 'wamid.220.v', p_work_kind => 'audio') $$,
    '22023', 'wa_ingest_inbound: p_work_kind must be media, flow or null',
    'the work kind is media, flow or null');
select throws_ok(
    $$ select tests._220_in('v.x10', tests.org_a(), '620022000001', 'wamid.220.v', p_media_type => 'sticker') $$,
    '22023', 'wa_ingest_inbound: p_media_type must be image, document, audio, video or null',
    'the media type is one the messages table stores (a sticker is stored as an image)');
select throws_ok(
    $$ select * from public.wa_apply_statuses(tests.org_a(), '{"id": "wamid.220.x"}') $$,
    '22023', 'wa_apply_statuses: p_statuses must be a JSON array',
    'the statuses are a JSON array');
select throws_ok(
    $$ select * from public.wa_apply_statuses(null, '[]') $$,
    '22004', 'wa_apply_statuses: p_org and p_statuses must not be null',
    'the statuses need their org');
select throws_ok(
    $$ select * from public.claim_inbound_work(0, 120, null) $$,
    '22023', 'claim_inbound_work: p_limit must be at least 1',
    'a claim takes at least one row');
select throws_ok(
    $$ select * from public.claim_inbound_work(10, 0, null) $$,
    '22023', 'claim_inbound_work: p_lease_seconds must be at least 1',
    'a claim leases for at least one second');

select tests._220_in('v1', tests.org_a(), null, 'wamid.220.v1', p_rate_scope => 'main');
select tests._220_in('v2', tests.org_a(), '', 'wamid.220.v2', p_bsuid => '', p_rate_scope => 'main');
select is(
    tests._220_f('v1', 'outcome', 'contact_key', 'message_id') || ' ' || tests._220_f('v2', 'outcome', 'contact_key'),
    'no_identity/-/- no_identity/-',
    'without a phone and a BSUID (an empty string counts as missing) the call answers no_identity');
select is(
    (select count(*)::int from public.whatsapp_chats where org_id = tests.org_a())
    + (select count(*)::int from public.whatsapp_messages where org_id = tests.org_a())
    + (select count(*)::int from public.rate_limits where identifier like tests.org_a()::text || '%'),
    0,
    'and writes nothing: no chat, no message, no rate count');

-- ---------------------------------------------------------------------------
-- 3. A call that fails in its last step leaves nothing behind, so Meta's
--    resend of the 503 does the work exactly once
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
create sequence tests._220_fail_seq;
grant usage on sequence tests._220_fail_seq to service_role;
-- A sequence is not rolled back with the failed call, so this fails once.
create function tests._220_fail_once()
returns trigger
language plpgsql
as $$
begin
    if nextval('tests._220_fail_seq') = 1 then
        raise exception 'tes: gagal sekali' using errcode = '40001';
    end if;
    return new;
end;
$$;
create trigger _220_fail_once before insert on public.message_queue
    for each row execute function tests._220_fail_once();
select tests.authenticate_as_service_role();

select throws_ok(
    $$ select tests._220_in('c1', tests.org_a(), '620022000101', 'wamid.220.c',
                            p_rate_scope => 'main', p_ai_eligible => true) $$,
    '40001', 'tes: gagal sekali',
    'a serialization failure in the last step (the queue insert) fails the whole call');
select is(
    format('chat=%s message=%s rate=%s quota=%s',
        (select count(*) from public.whatsapp_chats
          where org_id = tests.org_a() and phone_number = '620022000101'),
        (select count(*) from public.whatsapp_messages
          where org_id = tests.org_a() and wa_message_id = 'wamid.220.c'),
        (select count(*) from public.rate_limits where identifier = tests.org_a()::text || ':620022000101'),
        (select count(*) from public.org_usage_counters
          where org_id = tests.org_a() and metric = 'inbound_minute')),
    'chat=0 message=0 rate=0 quota=0',
    'and leaves nothing behind: no chat, no message, no rate count, no inbound_minute unit');

select tests._220_in('c2', tests.org_a(), '620022000101', 'wamid.220.c',
                     p_rate_scope => 'main', p_ai_eligible => true);
select is(tests._220_f('c2', 'outcome', 'queue_outcome', 'chat_created'), 'new/queued/true',
    'the resend of the same message is stored and queued');
select is(
    format('message=%s job=%s used=%s rate=%s',
        (select count(*) from public.whatsapp_messages
          where org_id = tests.org_a() and wa_message_id = 'wamid.220.c'),
        (select count(*) from public.message_queue where org_id = tests.org_a() and wa_message_id = 'wamid.220.c'),
        (select sum(used) from public.org_usage_counters
          where org_id = tests.org_a() and metric = 'inbound_minute'),
        (select request_count from public.rate_limits where identifier = tests.org_a()::text || ':620022000101')),
    'message=1 job=1 used=1 rate=1',
    'exactly once: one row, one job, one quota unit, one rate count');

select tests._220_in('c3', tests.org_a(), '620022000101', 'wamid.220.c',
                     p_rate_scope => 'main', p_ai_eligible => true);
select is(
    tests._220_f('c3', 'outcome') || format(' job=%s rate=%s',
        (select count(*) from public.message_queue where org_id = tests.org_a() and wa_message_id = 'wamid.220.c'),
        (select request_count from public.rate_limits where identifier = tests.org_a()::text || ':620022000101')),
    'duplicate job=1 rate=1',
    'a third delivery is a duplicate: still one job, and no rate count spent');

select tests.clear_authentication();
drop trigger _220_fail_once on public.message_queue;
select tests.authenticate_as_service_role();

-- ---------------------------------------------------------------------------
-- 4. A late resend changes nothing, and late statuses are stale
-- ---------------------------------------------------------------------------
select tests._220_in('l1', tests.org_a(), '620022000201', 'wamid.220.l1',
                     p_wa_ts => now() - interval '30 minutes', p_rate_scope => 'main', p_ai_eligible => true);
-- The reply went out and was read; the chat moved on.
insert into public.whatsapp_messages (org_id, phone_number, role, content, wa_message_id,
                                      status, status_updated_at, created_at)
values (tests.org_a(), '620022000201', 'assistant', 'balasan', 'wamid.220.l.out',
        'read', now() - interval '10 minutes', now() - interval '20 minutes');
update public.whatsapp_chats
   set last_message = 'balasan', last_message_at = now() - interval '20 minutes', unread_count = 0
 where org_id = tests.org_a() and phone_number = '620022000201';
-- Snapshots with the row versions (ctid): any write, even of equal values,
-- makes a new version.
insert into tests._220_res (label, res)
select 'l.chat', jsonb_build_object('row', to_jsonb(c), 'ctid', c.ctid::text)
  from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000201';
insert into tests._220_res (label, res)
select 'l.out', jsonb_build_object('row', to_jsonb(m), 'ctid', m.ctid::text)
  from public.whatsapp_messages m where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.l.out';
select tests._220_bus_mark('l.bus');

select tests._220_in('l2', tests.org_a(), '620022000201', 'wamid.220.l1',
                     p_wa_ts => now() - interval '30 minutes', p_rate_scope => 'main', p_ai_eligible => true);
select is(
    tests._220_f('l2', 'outcome') || ' same_id='
    || ((tests._220_r('l2') ->> 'message_id') = (tests._220_r('l1') ->> 'message_id'))::text,
    'duplicate same_id=true',
    'a late resend of a stored message is a duplicate of its row');
select is(
    (select jsonb_build_object('row', to_jsonb(c), 'ctid', c.ctid::text)
       from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000201'),
    tests._220_r('l.chat'),
    'it leaves the chat row untouched: preview, stamps, unread count and the 24 h marker stay');
select is(
    (select jsonb_build_object('row', to_jsonb(m), 'ctid', m.ctid::text)
       from public.whatsapp_messages m where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.l.out'),
    tests._220_r('l.out'),
    'and the reply''s row and status');
select is(
    format('rate=%s job=%s',
        (select request_count from public.rate_limits where identifier = tests.org_a()::text || ':620022000201'),
        (select count(*) from public.message_queue where org_id = tests.org_a() and phone_number = '620022000201')),
    'rate=1 job=1',
    'it spends no rate count and queues no second job');
select case when tests.realtime_partition_ready()
    then is(tests._220_bus_since('l.bus'), '{}'::text[], 'and broadcasts nothing')
    else skip('no realtime.messages partition for today (150 reports it)', 1) end;

select tests._220_st('l.st1', tests.org_a(), jsonb_build_array(jsonb_build_object(
    'id', 'wamid.220.l.out', 'status', 'delivered', 'ts', now() - interval '15 minutes')));
select tests._220_st('l.st2', tests.org_a(), jsonb_build_array(jsonb_build_object(
    'id', 'wamid.220.l.out', 'status', 'failed', 'ts', now() - interval '5 minutes',
    'error_code', 131047, 'error_title', 'Re-engagement message', 'error_detail', 'lewat 24 jam')));
select is(
    tests._220_f('l.st1', 'applied', 'stale') || ' ' || tests._220_f('l.st2', 'applied', 'stale') || ' '
    || (select format('%s/%s', m.status, coalesce(m.error_code::text, '-'))
          from public.whatsapp_messages m where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.l.out'),
    '0/1 0/1 read/-',
    'a late delivered and a failed after read are stale: the reply stays read, without error fields');

insert into public.whatsapp_messages (org_id, phone_number, role, content, wa_message_id,
                                      status, status_updated_at, error_code, error_title, error_detail)
values (tests.org_a(), '620022000201', 'assistant', 'balasan 2', 'wamid.220.l.out2',
        'failed', now() - interval '10 minutes', 131026, 'Message undeliverable', 'tidak terkirim');
select tests._220_st('l.st3', tests.org_a(), jsonb_build_array(jsonb_build_object(
    'id', 'wamid.220.l.out2', 'status', 'read', 'ts', now() - interval '5 minutes')));
select is(
    tests._220_f('l.st3', 'applied', 'stale') || ' '
    || (select format('%s/%s/%s/%s/%s', m.status, m.status_updated_at = now() - interval '5 minutes',
                      coalesce(m.error_code::text, '-'), coalesce(m.error_title, '-'), coalesce(m.error_detail, '-'))
          from public.whatsapp_messages m where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.l.out2'),
    '1/0 read/t/-/-/-',
    'read after failed with a newer Meta time applies, at that time, and clears the error fields');

-- ---------------------------------------------------------------------------
-- 5. Chat summary: Meta's time, forward only
-- ---------------------------------------------------------------------------
select tests._220_in('su1', tests.org_a(), '620022000301', 'wamid.220.su1',
                     p_preview => 'satu', p_wa_ts => now() - interval '2 hours');
select is(tests._220_f('su1', 'outcome', 'chat_created', 'summary_applied', 'ai_enabled', 'contact_name'),
    'new/true/true/true/-',
    'a first message creates the chat and applies the summary');
select is(
    (select format('%s|%s|%s|%s|%s|%s', c.last_message, c.last_message_at = now() - interval '2 hours',
                   c.last_inbound_at = c.last_message_at, c.unread_count, c.ai_enabled, c.contact_type)
       from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000301'),
    'satu|t|t|1|t|lead',
    'a new chat gets the defaults and its summary at Meta''s time (both stamps equal)');

select tests._220_in('su2', tests.org_a(), '620022000301', 'wamid.220.su2',
                     p_preview => 'dua', p_wa_ts => now() - interval '1 hour');
select is(
    tests._220_f('su2', 'summary_applied') || ' '
    || (select format('%s|%s|%s|%s', c.last_message, c.last_message_at = now() - interval '1 hour',
                      c.last_inbound_at = c.last_message_at, c.unread_count)
          from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000301'),
    'true dua|t|t|2',
    'a newer message moves the summary forward to its Meta time');

select tests._220_in('su3', tests.org_a(), '620022000301', 'wamid.220.su3',
                     p_preview => 'tiga', p_wa_ts => now() - interval '90 minutes');
select is(
    tests._220_f('su3', 'outcome', 'summary_applied') || ' '
    || (select format('%s|%s|%s|%s', c.last_message, c.last_message_at = now() - interval '1 hour',
                      c.last_inbound_at = c.last_message_at, c.unread_count)
          from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000301'),
    'new/false dua|t|t|3',
    'an older late message is stored but keeps the preview and both stamps; it still counts as unread');
select is(
    (select format('%s|%s', m.wa_timestamp = now() - interval '90 minutes', m.created_at = now())
       from public.whatsapp_messages m where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.su3'),
    't|t',
    'its row keeps Meta''s time in wa_timestamp; created_at stays the arrival time');

select tests._220_in('su4', tests.org_a(), '620022000301', 'wamid.220.su4',
                     p_preview => 'empat', p_wa_ts => now() + interval '3 minutes');
select is(
    (select format('%s|%s|%s', c.last_message, c.last_message_at = now(), c.last_inbound_at = now())
       from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000301')
    || ' ' || (select (m.wa_timestamp = now())::text
                 from public.whatsapp_messages m where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.su4'),
    'empat|t|t true',
    'a Meta time in the future is clamped to now(), in the summary and in wa_timestamp');

select tests._220_in('su5', tests.org_a(), '620022000301', 'wamid.220.su5', p_preview => 'lima');
select is(
    tests._220_f('su5', 'summary_applied') || ' '
    || (select format('%s|%s', c.last_message, c.last_inbound_at = now())
          from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000301')
    || ' ' || (select coalesce(m.wa_timestamp::text, '-')
                 from public.whatsapp_messages m where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.su5'),
    'true lima|t -',
    'without a Meta time the summary uses now() and wa_timestamp stays null');

select tests._220_in('su6', tests.org_a(), '620022000301', 'wamid.220.su6', p_preview => 'enam', p_unread => false);
select is(
    (select format('%s|%s', c.last_message, c.unread_count)
       from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000301'),
    'enam|5',
    'p_unread = false moves the summary but raises no unread count');

-- A lead added by hand: no last_message_at, so not in the inbox yet.
insert into public.whatsapp_chats (org_id, phone_number, contact_name, last_message_at)
values (tests.org_a(), '620022000302', 'Bu Ani', null);
select tests._220_in('su7', tests.org_a(), '620022000302', 'wamid.220.su7', p_preview => 'tujuh',
                     p_wa_ts => now() - interval '5 minutes', p_verified_phone => '620022000302');
select is(
    tests._220_f('su7', 'chat_created', 'summary_applied', 'contact_name') || ' '
    || (select format('%s|%s|%s', c.last_message_at = now() - interval '5 minutes', c.unread_count, c.verified_phone)
          from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000302'),
    'false/true/Bu Ani t|1|620022000302',
    'a lead added by hand joins the inbox with its first message; its contact name comes back for the push');

select tests._220_in('su8', tests.org_a(), '620022000302', 'wamid.220.su8', p_verified_phone => '');
select is(
    (select c.verified_phone from public.whatsapp_chats c
      where c.org_id = tests.org_a() and c.phone_number = '620022000302'),
    '620022000302',
    'an empty verified phone keeps the stored one');

-- ---------------------------------------------------------------------------
-- 6. Rate limit (the decision and identifiers of checkRateLimit)
-- ---------------------------------------------------------------------------
select tests._220_in('r' || g, tests.org_a(), '620022000401', 'wamid.220.r' || g, p_rate_scope => 'main')
  from generate_series(1, 12) g;
select is(
    (select string_agg(tests._220_f('r' || g, 'outcome'), ',' order by g) from generate_series(1, 10) g),
    'new,new,new,new,new,new,new,new,new,new',
    'ten messages of a contact within a minute are stored');
select is(tests._220_f('r11', 'outcome', 'rate_first', 'message_id', 'chat_created'),
    'rate_limited/true/-/false',
    'the eleventh is refused, as the first refusal of the window (the one to warn about)');
select is(tests._220_f('r12', 'outcome', 'rate_first'), 'rate_limited/false',
    'the twelfth is refused without rate_first (no second warning)');
select is(
    format('messages=%s count=%s',
        (select count(*) from public.whatsapp_messages where org_id = tests.org_a() and phone_number = '620022000401'),
        (select request_count from public.rate_limits where identifier = tests.org_a()::text || ':620022000401')),
    'messages=10 count=12',
    'refused messages are not stored; the count keeps rising, so only the first refusal is marked');

select tests._220_in('r13', tests.org_a(), '620022000401', 'wamid.220.r1', p_rate_scope => 'main');
select is(
    tests._220_f('r13', 'outcome') || format(' count=%s',
        (select request_count from public.rate_limits where identifier = tests.org_a()::text || ':620022000401')),
    'duplicate count=12',
    'a redelivery is answered before the rate limit and counts nothing');

update public.rate_limits set request_count = 10, window_start = now() - interval '60 seconds'
 where identifier = tests.org_a()::text || ':620022000401';
select tests._220_in('r14', tests.org_a(), '620022000401', 'wamid.220.r14', p_rate_scope => 'main');
select is(tests._220_f('r14', 'outcome', 'rate_first'), 'rate_limited/true',
    'a window exactly 60 s old still counts (checkRateLimit starts over only after more than 60 s)');

update public.rate_limits set window_start = now() - interval '61 seconds'
 where identifier = tests.org_a()::text || ':620022000401';
select tests._220_in('r15', tests.org_a(), '620022000401', 'wamid.220.r15', p_rate_scope => 'main');
select is(
    tests._220_f('r15', 'outcome')
    || (select format(' count=%s window_now=%s', r.request_count, r.window_start = now())
          from public.rate_limits r where r.identifier = tests.org_a()::text || ':620022000401'),
    'new count=1 window_now=t',
    'a window older than 60 s starts over');

insert into public.rate_limits (identifier, request_count, window_start)
values (tests.org_a()::text || ':620022000402', 10, now());
select tests._220_in('r16', tests.org_a(), '620022000402', 'wamid.220.r16', p_rate_scope => 'main');
select is(
    tests._220_f('r16', 'outcome', 'contact_key') || format(' chats=%s messages=%s',
        (select count(*) from public.whatsapp_chats where org_id = tests.org_a() and phone_number = '620022000402'),
        (select count(*) from public.whatsapp_messages where org_id = tests.org_a() and phone_number = '620022000402')),
    'rate_limited/620022000402 chats=0 messages=0',
    'a rate-limited new contact gets no chat row and no message');

select tests._220_in('r17', tests.org_a(), '620022000403', 'wamid.220.r17', p_rate_scope => 'main');
select tests._220_in('r18', tests.org_a(), '620022000403', 'wamid.220.r18', p_rate_scope => 'other');
select is(
    (select array_agg(r.identifier || '=' || r.request_count order by r.identifier collate "C")
       from public.rate_limits r where r.identifier like '%:620022000403'),
    array[tests.org_a()::text || ':620022000403=1', tests.org_a()::text || ':other:620022000403=1'],
    'the identifiers are exactly <org>:<key> (main number) and <org>:other:<key> (another number)');

select tests.clear_authentication();
create function tests._220_rate_fails()
returns trigger
language plpgsql
as $$
begin
    raise exception 'tes: rate limit tidak terbaca';
end;
$$;
create trigger _220_rate_fails before insert or update on public.rate_limits
    for each row execute function tests._220_rate_fails();
select tests.authenticate_as_service_role();
select lives_ok(
    $$ select tests._220_in('r19', tests.org_a(), '620022000404', 'wamid.220.r19', p_rate_scope => 'main') $$,
    'a rate-limit step that fails does not fail the call');
select is(
    tests._220_f('r19', 'outcome', 'rate_error', 'rate_first') || format(' rate_rows=%s messages=%s',
        (select count(*) from public.rate_limits where identifier like '%:620022000404'),
        (select count(*) from public.whatsapp_messages where org_id = tests.org_a() and phone_number = '620022000404')),
    'new/P0001/false rate_rows=0 messages=1',
    'a failing rate-limit step lets the message through (fail-open) and reports its SQLSTATE');
select tests.clear_authentication();
drop trigger _220_rate_fails on public.rate_limits;
select tests.authenticate_as_service_role();

-- ---------------------------------------------------------------------------
-- 7. AI decision and the inbound_minute quota (org B, limit 2)
-- ---------------------------------------------------------------------------
select tests._220_in('q1', tests.org_b(), '620022000501', 'wamid.220.q1', p_preview => 'harga paket?',
                     p_ai_eligible => true, p_queue_text => 'harga paket?', p_inbound_limit => 2);
select is(tests._220_f('q1', 'outcome', 'queue_outcome', 'quota_limit', 'quota_first_refusal', 'quota_error'),
    'new/queued/2/false/-',
    'an AI-eligible message opens a burst: one inbound_minute unit and one job');
select is(
    (select format('%s|%s|%s|%s|%s', q.message_text, q.status, q.created_at = now(), q.ai_quota_counted, q.phone_number)
       from public.message_queue q where q.org_id = tests.org_b() and q.wa_message_id = 'wamid.220.q1'),
    'harga paket?|pending|t|f|620022000501',
    'the job carries the queue text and the wamid, pending, created at now() (the debounce clock)');

select tests._220_in('q2', tests.org_b(), '620022000501', 'wamid.220.q2', p_ai_eligible => true, p_inbound_limit => 2);
select is(
    tests._220_f('q2', 'queue_outcome', 'quota_limit') || format(' jobs=%s used=%s',
        (select count(*) from public.message_queue where org_id = tests.org_b() and phone_number = '620022000501'),
        (select sum(used) from public.org_usage_counters where org_id = tests.org_b() and metric = 'inbound_minute')),
    'joined/- jobs=2 used=1',
    'a fragment that joins the burst still waiting in the queue gets its job without a quota unit');

insert into public.whatsapp_chats (org_id, phone_number, ai_enabled) values (tests.org_b(), '620022000502', false);
select tests._220_in('q3', tests.org_b(), '620022000502', 'wamid.220.q3', p_ai_eligible => true, p_inbound_limit => 2);
select is(
    tests._220_f('q3', 'outcome', 'queue_outcome', 'ai_enabled') || format(' messages=%s jobs=%s used=%s',
        (select count(*) from public.whatsapp_messages where org_id = tests.org_b() and phone_number = '620022000502'),
        (select count(*) from public.message_queue where org_id = tests.org_b() and phone_number = '620022000502'),
        (select sum(used) from public.org_usage_counters where org_id = tests.org_b() and metric = 'inbound_minute')),
    'new/manual/false messages=1 jobs=0 used=1',
    'AI off for the chat: stored, no job, no quota unit (manual)');

select tests._220_in('q4', tests.org_b(), '620022000503', 'wamid.220.q4', p_ai_eligible => true, p_inbound_limit => 2);
select tests._220_in('q5', tests.org_b(), '620022000504', 'wamid.220.q5', p_ai_eligible => true, p_inbound_limit => 2);
select tests._220_in('q6', tests.org_b(), '620022000505', 'wamid.220.q6', p_ai_eligible => true, p_inbound_limit => 2);
select is(tests._220_f('q4', 'queue_outcome', 'quota_limit'), 'queued/2',
    'a second burst takes the last unit of the minute');
select is(
    tests._220_f('q5', 'outcome', 'queue_outcome', 'quota_limit', 'quota_first_refusal')
    || format(' messages=%s jobs=%s',
        (select count(*) from public.whatsapp_messages where org_id = tests.org_b() and phone_number = '620022000504'),
        (select count(*) from public.message_queue where org_id = tests.org_b() and phone_number = '620022000504')),
    'new/refused/2/true messages=1 jobs=0',
    'the next burst is refused by the quota but stored; it is the first refusal (the alerted one)');
select is(tests._220_f('q6', 'queue_outcome', 'quota_first_refusal'), 'refused/false',
    'later refusals are not alerted again');

select tests.clear_authentication();
create function tests._220_quota_fails()
returns trigger
language plpgsql
as $$
begin
    raise exception 'tes: penghitung kuota tidak terbaca';
end;
$$;
create trigger _220_quota_fails before insert or update on public.org_usage_counters
    for each row execute function tests._220_quota_fails();
select tests.authenticate_as_service_role();
select lives_ok(
    $$ select tests._220_in('q7', tests.org_b(), '620022000506', 'wamid.220.q7',
                            p_ai_eligible => true, p_inbound_limit => 2) $$,
    'a quota step that fails does not fail the call');
select is(
    tests._220_f('q7', 'queue_outcome', 'quota_error', 'quota_limit') || format(' jobs=%s',
        (select count(*) from public.message_queue where org_id = tests.org_b() and phone_number = '620022000506')),
    'queued/P0001/- jobs=1',
    'a failing quota step lets the message through (fail-open, although the quota is used up) '
    || 'and reports its SQLSTATE');
select tests.clear_authentication();
drop trigger _220_quota_fails on public.org_usage_counters;
select tests.authenticate_as_service_role();

insert into public.message_queue (org_id, phone_number, message_text, wa_message_id, status)
values (tests.org_b(), '620022000507', 'jalur lama', 'wamid.220.q8', 'pending');
select tests._220_in('q8', tests.org_b(), '620022000507', 'wamid.220.q8', p_ai_eligible => true, p_inbound_limit => 2);
select is(
    tests._220_f('q8', 'outcome', 'queue_outcome', 'quota_limit') || format(' jobs=%s refused=%s',
        (select count(*) from public.message_queue where org_id = tests.org_b() and wa_message_id = 'wamid.220.q8'),
        (select sum(refused) from public.org_usage_counters
          where org_id = tests.org_b() and metric = 'inbound_minute')),
    'new/already_queued/- jobs=1 refused=2',
    'a job of this wamid from the old code path: the message is stored, without a second job or a quota unit');

-- The same wamid queued by another delivery while the quota was counted.
select tests.clear_authentication();
create function tests._220_queue_race()
returns trigger
language plpgsql
as $$
begin
    insert into public.message_queue (org_id, phone_number, message_text, wa_message_id, status)
    values (tests.org_a(), '620022000508', 'kiriman lain', 'wamid.220.q9', 'pending');
    return null;
end;
$$;
create trigger _220_queue_race after insert or update on public.org_usage_counters
    for each row execute function tests._220_queue_race();
select tests.authenticate_as_service_role();
select lives_ok(
    $$ select tests._220_in('q9', tests.org_a(), '620022000509', 'wamid.220.q9', p_ai_eligible => true) $$,
    'a job of this wamid written meanwhile does not fail the call');
select is(
    tests._220_f('q9', 'outcome', 'queue_outcome') || format(' jobs=%s',
        (select count(*) from public.message_queue where org_id = tests.org_a() and wa_message_id = 'wamid.220.q9')),
    'new/already_queued jobs=1',
    'a job of this wamid written meanwhile: the queue insert skips it (ON CONFLICT) instead of failing');
select tests.clear_authentication();
drop trigger _220_queue_race on public.org_usage_counters;
select tests.authenticate_as_service_role();

select tests._220_in('q10', tests.org_b(), '620022000510', 'wamid.220.q10');
select is(
    tests._220_f('q10', 'outcome', 'queue_outcome', 'quota_limit', 'quota_error') || format(' jobs=%s',
        (select count(*) from public.message_queue where org_id = tests.org_b() and phone_number = '620022000510')),
    'new/-/-/- jobs=0',
    'a message that is not AI-eligible (another number, a late text, a summary line) gets no AI decision');

select ok(
    tests._220_lock_held(tests.org_b(), '620022000501') and not tests._220_lock_held(tests.org_a(), '620022000501'),
    'the advisory lock of (org, contact key) is held until the end of the transaction');

-- ---------------------------------------------------------------------------
-- 8. Identity, and the realtime broadcasts of one call
-- ---------------------------------------------------------------------------
insert into public.whatsapp_chats (org_id, phone_number, bsuid) values (tests.org_a(), '620022000601', 'ID.220.A1');
select tests._220_in('i1', tests.org_a(), '620022000699', 'wamid.220.i1', p_bsuid => 'ID.220.A1');
select is(tests._220_f('i1', 'outcome', 'contact_key', 'chat_created'), 'new/620022000601/false',
    'the chat holding the BSUID wins over the phone Meta sends');

select tests._220_in('i2', tests.org_b(), null, 'wamid.220.i2', p_bsuid => 'ID.220.A1');
select is(
    tests._220_f('i2', 'contact_key', 'chat_created') || ' '
    || (select coalesce(c.bsuid, '-') from public.whatsapp_chats c
         where c.org_id = tests.org_b() and c.phone_number = 'ID.220.A1'),
    'ID.220.A1/true ID.220.A1',
    'a BSUID resolves only in its own org; a contact known only by its BSUID is keyed by it');

select tests._220_in('i3', tests.org_a(), '620022000602', 'wamid.220.i3', p_bsuid => 'ID.220.A2');
select tests._220_in('i4', tests.org_a(), null, 'wamid.220.i4', p_bsuid => 'ID.220.A2');
select is(
    (select c.bsuid from public.whatsapp_chats c where c.org_id = tests.org_a() and c.phone_number = '620022000602')
    || ' ' || tests._220_f('i4', 'contact_key', 'chat_created', 'bsuid_conflict'),
    'ID.220.A2 620022000602/false/false',
    'a new BSUID is stored on the chat, and a later message carrying only the BSUID finds that chat');

-- Another chat of the org takes the BSUID after the lookup (during the rate
-- step).
insert into public.whatsapp_chats (org_id, phone_number) values (tests.org_a(), '620022000603');
select tests.clear_authentication();
create function tests._220_bsuid_race()
returns trigger
language plpgsql
as $$
begin
    update public.whatsapp_chats set bsuid = 'ID.220.A3'
     where org_id = tests.org_a() and phone_number = '620022000603';
    return null;
end;
$$;
create trigger _220_bsuid_race after insert or update on public.rate_limits
    for each row execute function tests._220_bsuid_race();
select tests.authenticate_as_service_role();
select lives_ok(
    $$ select tests._220_in('i5', tests.org_a(), '620022000604', 'wamid.220.i5',
                            p_bsuid => 'ID.220.A3', p_rate_scope => 'main') $$,
    'a BSUID held by another chat does not fail the call');
select is(
    tests._220_f('i5', 'outcome', 'contact_key', 'bsuid_conflict') || format(' messages=%s bsuid=%s',
        (select count(*) from public.whatsapp_messages where org_id = tests.org_a() and phone_number = '620022000604'),
        (select coalesce(c.bsuid, '-') from public.whatsapp_chats c
          where c.org_id = tests.org_a() and c.phone_number = '620022000604')),
    'new/620022000604/true messages=1 bsuid=-',
    'a BSUID another chat took meanwhile: the message is stored and the conflict reported');
select tests.clear_authentication();
drop trigger _220_bsuid_race on public.rate_limits;

-- Another delivery of the same wamid, under another contact key, commits
-- after the redelivery gate (during the rate step).
create function tests._220_wamid_race()
returns trigger
language plpgsql
as $$
begin
    insert into public.whatsapp_chats (org_id, phone_number) values (tests.org_a(), '620022000606');
    insert into public.whatsapp_messages (org_id, phone_number, role, content, wa_message_id)
    values (tests.org_a(), '620022000606', 'user', 'kiriman pertama', 'wamid.220.i6');
    return null;
end;
$$;
create trigger _220_wamid_race after insert or update on public.rate_limits
    for each row execute function tests._220_wamid_race();
select tests.authenticate_as_service_role();
select lives_ok(
    $$ select tests._220_in('i6', tests.org_a(), '620022000605', 'wamid.220.i6', p_rate_scope => 'main') $$,
    'a wamid stored meanwhile under another contact key does not fail the call');
select is(
    tests._220_f('i6', 'outcome', 'chat_created', 'contact_key') || ' same_id='
    || ((tests._220_r('i6') ->> 'message_id')
        = (select m.id::text from public.whatsapp_messages m
            where m.org_id = tests.org_a() and m.wa_message_id = 'wamid.220.i6'))::text,
    'duplicate/false/620022000605 same_id=true',
    'the same wamid stored meanwhile under another contact key: the call answers duplicate with that row');
select is(
    (select count(*)::int from public.whatsapp_chats where org_id = tests.org_a() and phone_number = '620022000605'),
    0,
    'and the chat this call created is gone (no empty chat in the inbox)');
select tests.clear_authentication();
drop trigger _220_wamid_race on public.rate_limits;
select tests.authenticate_as_service_role();

select tests._220_bus_mark('i7.bus');
select tests._220_in('i7', tests.org_a(), '620022000602', 'wamid.220.i7');
select case when tests.realtime_partition_ready()
    then is(tests._220_bus_since('i7.bus'), array['whatsapp_chats UPDATE', 'whatsapp_messages INSERT'],
            'a new message on an existing chat broadcasts twice: the message insert and the chat update')
    else skip('no realtime.messages partition for today (150 reports it)', 1) end;
select tests._220_bus_mark('i8.bus');
select tests._220_in('i8', tests.org_a(), '620022000607', 'wamid.220.i8');
select case when tests.realtime_partition_ready()
    then is(tests._220_bus_since('i8.bus'),
            array['whatsapp_chats INSERT', 'whatsapp_chats UPDATE', 'whatsapp_messages INSERT'],
            'a new chat broadcasts three times: the chat insert, the message insert and the chat update')
    else skip('no realtime.messages partition for today (150 reports it)', 1) end;
select tests._220_bus_mark('i9.bus');
select tests._220_in('i9', tests.org_a(), '620022000607', 'wamid.220.i8');
select case when tests.realtime_partition_ready()
    then is(tests._220_f('i9', 'outcome') || ' ' || array_to_string(tests._220_bus_since('i9.bus'), ','),
            'duplicate ',
            'a duplicate broadcasts nothing')
    else skip('no realtime.messages partition for today (150 reports it)', 1) end;

-- ---------------------------------------------------------------------------
-- 9. Statuses: forward only, on the org's assistant rows
-- ---------------------------------------------------------------------------
insert into public.whatsapp_chats (org_id, phone_number) values
    (tests.org_a(), '620022000701'),
    (tests.org_b(), '620022000701');

-- The full matrix: one assistant row per (current, incoming) status, the
-- current one 10 minutes old, the incoming one 5 minutes.
insert into public.whatsapp_messages (org_id, phone_number, role, content, wa_message_id,
                                      status, status_updated_at, error_code, error_title, error_detail)
select tests.org_a(), '620022000701', 'assistant', 'matriks', 'wamid.220.m.' || c.cur || '.' || n.new,
       nullif(c.cur, 'none'),
       case when c.cur <> 'none' then now() - interval '10 minutes' end,
       case when c.cur = 'failed' then 100 end,
       case when c.cur = 'failed' then 'lama' end,
       case when c.cur = 'failed' then 'lama' end
  from unnest(array['none', 'sent', 'delivered', 'read', 'failed']) as c(cur)
  cross join unnest(array['sent', 'delivered', 'read', 'failed']) as n(new);
insert into tests._220_res (label, res)
select 'st.matrix', jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', 'wamid.220.m.' || c.cur || '.' || n.new,
           'status', n.new,
           'ts', now() - interval '5 minutes',
           'error_code', case when n.new = 'failed' then 131047 end,
           'error_title', case when n.new = 'failed' then 'Re-engagement message' end,
           'error_detail', case when n.new = 'failed' then 'lewat 24 jam' end)))
  from unnest(array['none', 'sent', 'delivered', 'read', 'failed']) as c(cur)
  cross join unnest(array['sent', 'delivered', 'read', 'failed']) as n(new);
select tests._220_st('st1', tests.org_a(), tests._220_r('st.matrix'));
select is(tests._220_f('st1', 'applied', 'stale', 'unknown', 'unknown_ids'), '10/10/0/[]',
    'the matrix: 10 transitions apply, 10 are stale, no unknown id');
select results_eq(
    $$ select replace(m.wa_message_id, 'wamid.220.m.', ''), m.status,
              m.status_updated_at = now() - interval '5 minutes', m.error_code, m.error_title
         from public.whatsapp_messages m
        where m.org_id = tests.org_a() and m.wa_message_id like 'wamid.220.m.%'
        order by m.wa_message_id collate "C" $$,
    $$ values ('delivered.delivered', 'delivered', false, null::integer, null::text),
              ('delivered.failed', 'delivered', false, null, null),
              ('delivered.read', 'read', true, null, null),
              ('delivered.sent', 'delivered', false, null, null),
              ('failed.delivered', 'delivered', true, null, null),
              ('failed.failed', 'failed', false, 100, 'lama'),
              ('failed.read', 'read', true, null, null),
              ('failed.sent', 'failed', false, 100, 'lama'),
              ('none.delivered', 'delivered', true, null, null),
              ('none.failed', 'failed', true, 131047, 'Re-engagement message'),
              ('none.read', 'read', true, null, null),
              ('none.sent', 'sent', true, null, null),
              ('read.delivered', 'read', false, null, null),
              ('read.failed', 'read', false, null, null),
              ('read.read', 'read', false, null, null),
              ('read.sent', 'read', false, null, null),
              ('sent.delivered', 'delivered', true, null, null),
              ('sent.failed', 'failed', true, 131047, 'Re-engagement message'),
              ('sent.read', 'read', true, null, null),
              ('sent.sent', 'sent', false, null, null) $$,
    'forward only: sent < delivered < read, failed only over sent, delivered or read over a failed '
    || 'with a newer Meta time; status_updated_at = Meta''s time; error fields set for failed, '
    || 'cleared when overridden, kept on a stale row');

insert into public.whatsapp_messages (org_id, phone_number, role, content, wa_message_id, status, status_updated_at)
values (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.f.old', 'failed', now() - interval '10 minutes'),
       (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.f.nots', 'failed', now() - interval '10 minutes'),
       (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.f.nostamp', 'failed', null),
       (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.fut', null, null),
       (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.nots', null, null);
select tests._220_st('st2', tests.org_a(), jsonb_build_array(
    jsonb_build_object('id', 'wamid.220.f.old', 'status', 'delivered', 'ts', now() - interval '20 minutes'),
    jsonb_build_object('id', 'wamid.220.f.nots', 'status', 'read', 'ts', null),
    jsonb_build_object('id', 'wamid.220.f.nostamp', 'status', 'delivered', 'ts', now() - interval '20 minutes'),
    jsonb_build_object('id', 'wamid.220.fut', 'status', 'sent', 'ts', now() + interval '1 hour'),
    jsonb_build_object('id', 'wamid.220.nots', 'status', 'delivered')));
select is(
    tests._220_f('st2', 'applied', 'stale') || ' '
    || (select string_agg(format('%s=%s', replace(m.wa_message_id, 'wamid.220.', ''), m.status), ','
                          order by m.wa_message_id collate "C")
          from public.whatsapp_messages m
         where m.wa_message_id in ('wamid.220.f.old', 'wamid.220.f.nots', 'wamid.220.f.nostamp')),
    '3/2 f.nostamp=delivered,f.nots=failed,f.old=failed',
    'delivered or read override a failed only with a newer Meta time; an older one, or none, is stale');
select is(
    (select string_agg(format('%s=%s/%s', replace(m.wa_message_id, 'wamid.220.', ''), m.status,
                              m.status_updated_at = now()), ',' order by m.wa_message_id collate "C")
       from public.whatsapp_messages m where m.wa_message_id in ('wamid.220.fut', 'wamid.220.nots')),
    'fut=sent/t,nots=delivered/t',
    'status_updated_at is never later than now(), and now() without a Meta time');

insert into public.whatsapp_messages (org_id, phone_number, role, content, wa_message_id, status, status_updated_at)
values (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.c1', 'sent', now() - interval '10 minutes'),
       (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.c2', null, null),
       (tests.org_a(), '620022000701', 'assistant', 'x', 'wamid.220.c3', null, null);
select tests._220_st('st3', tests.org_a(), jsonb_build_array(
    jsonb_build_object('id', 'wamid.220.c1', 'status', 'delivered', 'ts', now() - interval '9 minutes'),
    jsonb_build_object('id', 'wamid.220.c1', 'status', 'read', 'ts', now() - interval '8 minutes'),
    jsonb_build_object('id', 'wamid.220.c1', 'status', 'sent', 'ts', now() - interval '7 minutes'),
    jsonb_build_object('id', 'wamid.220.c1', 'status', 'failed', 'ts', now() - interval '6 minutes', 'error_code', 1),
    jsonb_build_object('id', 'wamid.220.c2', 'status', 'failed', 'ts', now() - interval '8 minutes',
                       'error_code', 131026),
    jsonb_build_object('id', 'wamid.220.c2', 'status', 'failed', 'ts', now() - interval '6 minutes',
                       'error_code', 131047),
    jsonb_build_object('id', 'wamid.220.c3', 'status', 'delivered', 'ts', now() - interval '7 minutes'),
    jsonb_build_object('id', 'wamid.220.c3', 'status', 'delivered')));
select is(
    tests._220_f('st3', 'applied', 'stale', 'unknown') || ' '
    || (select string_agg(format('%s=%s/%s/%s', replace(m.wa_message_id, 'wamid.220.', ''), m.status,
                                 extract(epoch from now() - m.status_updated_at)::int / 60,
                                 coalesce(m.error_code::text, '-')), ',' order by m.wa_message_id collate "C")
          from public.whatsapp_messages m where m.wa_message_id in ('wamid.220.c1', 'wamid.220.c2', 'wamid.220.c3')),
    '3/0/0 c1=read/8/-,c2=failed/6/131047,c3=delivered/7/-',
    'the statuses of one id collapse: the highest wins (read > delivered > failed > sent), '
    || 'a tie goes to the newest Meta time');

insert into public.whatsapp_messages (org_id, phone_number, role, content, wa_message_id, status) values
    (tests.org_a(), '620022000701', 'user', 'pesan pelanggan', 'wamid.220.u', null),
    (tests.org_a(), '620022000701', 'system', 'catatan', 'wamid.220.sys', null),
    (tests.org_b(), '620022000701', 'assistant', 'balasan org B', 'wamid.220.ob', 'sent');
select tests._220_st('st4', tests.org_a(), jsonb_build_array(
    jsonb_build_object('id', 'wamid.220.u', 'status', 'read', 'ts', now() - interval '1 minute'),
    jsonb_build_object('id', 'wamid.220.sys', 'status', 'delivered', 'ts', now() - interval '1 minute'),
    jsonb_build_object('id', 'wamid.220.ob', 'status', 'read', 'ts', now() - interval '1 minute'),
    jsonb_build_object('id', 'wamid.220.none', 'status', 'sent'),
    42, 'teks', null, '[]'::jsonb,
    jsonb_build_object('status', 'read'),
    jsonb_build_object('id', '', 'status', 'read'),
    jsonb_build_object('id', 'wamid.220.m.none.sent', 'status', 'deleted')));
select is(tests._220_f('st4', 'applied', 'stale', 'unknown', 'unknown_ids'),
    '0/0/4/["wamid.220.none", "wamid.220.ob", "wamid.220.sys", "wamid.220.u"]',
    'only the org''s assistant rows take statuses: a user row, a system note and another org''s row are '
    || 'unknown; non-objects, untracked statuses and objects without an id are ignored');
select is(
    (select string_agg(format('%s=%s', replace(m.wa_message_id, 'wamid.220.', ''), coalesce(m.status, '-')), ','
                       order by m.wa_message_id collate "C")
       from public.whatsapp_messages m where m.wa_message_id in ('wamid.220.u', 'wamid.220.sys', 'wamid.220.ob')),
    'ob=sent,sys=-,u=-',
    'and those rows keep their status');

select tests._220_st('st5', tests.org_a(), tests._220_r('st.matrix'));
select is(tests._220_f('st5', 'applied', 'stale', 'unknown'), '0/20/0',
    'the same statuses again change nothing (a resend of the change)');

insert into public.whatsapp_chats (org_id, phone_number, bsuid) values
    (tests.org_a(), '620022000702', null),
    (tests.org_a(), '620022000703', 'ID.220.OLD'),
    (tests.org_a(), '620022000704', null),
    (tests.org_a(), '620022000705', 'ID.220.B3');
select tests._220_st('st6', tests.org_a(), jsonb_build_array(
    jsonb_build_object('id', 'wamid.220.b1', 'status', 'delivered',
                       'recipient_id', '620022000702', 'recipient_user_id', 'ID.220.B1'),
    jsonb_build_object('id', 'wamid.220.b2', 'status', 'read',
                       'recipient_id', '620022000702', 'recipient_user_id', 'ID.220.B1'),
    jsonb_build_object('id', 'wamid.220.b3', 'status', 'sent',
                       'recipient_id', '620022000703', 'recipient_user_id', 'ID.220.B2'),
    jsonb_build_object('id', 'wamid.220.b4', 'status', 'sent',
                       'recipient_id', '620022000704', 'recipient_user_id', 'ID.220.B3'),
    jsonb_build_object('id', 'wamid.220.b5', 'status', 'deleted',
                       'recipient_id', '620022000704', 'recipient_user_id', 'ID.220.B5'),
    jsonb_build_object('id', 'wamid.220.b6', 'status', 'sent',
                       'recipient_id', '620022000704', 'recipient_user_id', '')));
select is(
    tests._220_f('st6', 'bsuid_filled', 'bsuid_conflicts') || ' '
    || (select string_agg(format('%s=%s', c.phone_number, coalesce(c.bsuid, '-')), ',' order by c.phone_number)
          from public.whatsapp_chats c
         where c.org_id = tests.org_a() and c.phone_number in ('620022000702', '620022000703', '620022000704')),
    '1/0 620022000702=ID.220.B1,620022000703=ID.220.OLD,620022000704=-',
    'the recipient''s BSUID is backfilled only on a chat without one, and only while no chat of the org holds it');

-- Another chat takes the BSUID within the backfill's own statement.
insert into public.whatsapp_chats (org_id, phone_number) values
    (tests.org_a(), '620022000706'),
    (tests.org_a(), '620022000707');
select tests.clear_authentication();
create function tests._220_bsuid_steal()
returns trigger
language plpgsql
as $$
begin
    update public.whatsapp_chats set bsuid = new.bsuid
     where org_id = new.org_id and phone_number = '620022000707';
    return new;
end;
$$;
create trigger _220_bsuid_steal before update of bsuid on public.whatsapp_chats
    for each row when (new.phone_number = '620022000706' and new.bsuid is not null)
    execute function tests._220_bsuid_steal();
select tests.authenticate_as_service_role();
select tests._220_st('st7', tests.org_a(), jsonb_build_array(
    jsonb_build_object('id', 'wamid.220.b7', 'status', 'sent',
                       'recipient_id', '620022000706', 'recipient_user_id', 'ID.220.B7')));
select is(
    tests._220_f('st7', 'bsuid_filled', 'bsuid_conflicts') || ' '
    || (select string_agg(format('%s=%s', c.phone_number, coalesce(c.bsuid, '-')), ',' order by c.phone_number)
          from public.whatsapp_chats c
         where c.org_id = tests.org_a() and c.phone_number in ('620022000706', '620022000707')),
    '0/1 620022000706=-,620022000707=-',
    'a BSUID taken by another chat meanwhile counts as a conflict, and only that backfill is undone');
select tests.clear_authentication();
drop trigger _220_bsuid_steal on public.whatsapp_chats;
select tests.authenticate_as_service_role();

-- ---------------------------------------------------------------------------
-- 10. Work rows: written with the message, claimed, failed, cleaned up
-- ---------------------------------------------------------------------------
select tests._220_in('w1', tests.org_a(), '620022000801', 'wamid.220.w1', p_preview => 'Foto', p_media_type => 'image',
                     p_work_kind => 'media', p_work_payload => '{"media_id": "m-220", "kind": "image"}');
select is(
    tests._220_f('w1', 'outcome', 'work_state') || ' '
    || (select format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
                      w.id::text = tests._220_r('w1') ->> 'work_id',
                      w.message_id::text = tests._220_r('w1') ->> 'message_id',
                      w.kind, w.state, w.attempts, w.max_attempts, w.next_attempt_at = now(),
                      coalesce(w.lease_until::text, '-'), w.payload, w.steps)
          from public.whatsapp_inbound_work w where w.org_id = tests.org_a()),
    'new/pending t|t|media|pending|0|6|t|-|{"kind": "image", "media_id": "m-220"}|{}',
    'a message with follow-up work gets its work row in the same call: pending, due now, 6 attempts');

select tests._220_in('w2', tests.org_a(), '620022000801', 'wamid.220.w1', p_work_kind => 'media');
select is(
    tests._220_f('w2', 'outcome', 'work_state') || ' same_work='
    || ((tests._220_r('w2') ->> 'work_id') = (tests._220_r('w1') ->> 'work_id'))::text
    || format(' rows=%s', (select count(*) from public.whatsapp_inbound_work w where w.org_id = tests.org_a())),
    'duplicate/pending same_work=true rows=1',
    'a resend of that message is a duplicate that hands back the open work row (to kick it), without a second row');

select tests._220_claim('wc1', 10, 120);
select is(
    (select string_agg(format('%s|%s|%s|%s', e ->> 'id' = tests._220_r('w1') ->> 'work_id', e ->> 'state',
                              e ->> 'attempts',
                              (e ->> 'lease_until')::timestamptz = now() + interval '120 seconds'), ',')
       from jsonb_array_elements(tests._220_r('wc1')) e),
    't|running|1|t',
    'a claim leases the due row: running, one attempt counted, leased for p_lease_seconds');
select tests._220_claim('wc2', 10, 120);
select is(tests._220_r('wc2'), '[]'::jsonb, 'a second claim gets nothing while the lease runs');

update public.whatsapp_inbound_work set lease_until = now() - interval '1 second'
 where id = (tests._220_r('w1') ->> 'work_id')::uuid;
select tests._220_claim('wc3', 10, 120);
select is(
    (select string_agg(format('%s|%s|%s', e ->> 'id' = tests._220_r('w1') ->> 'work_id', e ->> 'state',
                              e ->> 'attempts'), ',')
       from jsonb_array_elements(tests._220_r('wc3')) e),
    't|running|2',
    'a running row whose lease ran out (a worker died) is claimed again, counting another attempt');

update public.whatsapp_inbound_work set attempts = 6, lease_until = now() - interval '1 second'
 where id = (tests._220_r('w1') ->> 'work_id')::uuid;
select tests._220_claim('wc4', 10, 120);
select tests._220_claim('wc5', 10, 120);
select is(
    (select string_agg(format('%s|%s|%s|%s', e ->> 'id' = tests._220_r('w1') ->> 'work_id', e ->> 'state',
                              e ->> 'attempts', coalesce(e ->> 'lease_until', '-')), ',')
       from jsonb_array_elements(tests._220_r('wc4')) e)
    || ' then ' || tests._220_r('wc5')::text,
    't|failed|6|- then []',
    'a row whose lease ran out on its last attempt comes back once, as failed, and is never claimed again');

select tests._220_in('w3', tests.org_a(), '620022000802', 'wamid.220.w3',
                     p_work_kind => 'flow', p_work_payload => '{"response_json": "{}"}');
select tests._220_in('w4', tests.org_a(), '620022000803', 'wamid.220.w4', p_work_kind => 'media');
select tests._220_claim('wc6', 10, 60, (tests._220_r('w4') ->> 'work_id')::uuid);
select is(
    format('%s|%s',
        (select string_agg(e ->> 'id', ',') from jsonb_array_elements(tests._220_r('wc6')) e)
            = tests._220_r('w4') ->> 'work_id',
        (select w.state from public.whatsapp_inbound_work w where w.id = (tests._220_r('w3') ->> 'work_id')::uuid)),
    't|pending',
    'a claim with p_id takes only that row (the kick right after the message was stored)');

update public.whatsapp_inbound_work set next_attempt_at = now() - interval '2 minutes'
 where id = (tests._220_r('w3') ->> 'work_id')::uuid;
update public.whatsapp_inbound_work
   set state = 'pending', lease_until = null, next_attempt_at = now() - interval '1 minute'
 where id = (tests._220_r('w4') ->> 'work_id')::uuid;
select tests._220_in('w5', tests.org_a(), '620022000804', 'wamid.220.w5', p_work_kind => 'media');
update public.whatsapp_inbound_work set next_attempt_at = now() + interval '1 minute'
 where id = (tests._220_r('w5') ->> 'work_id')::uuid;
select tests._220_claim('wc7', 1, 60);
select tests._220_claim('wc8', 10, 60);
select is(
    format('%s|%s',
        (select string_agg(e ->> 'id', ',') from jsonb_array_elements(tests._220_r('wc7')) e)
            = tests._220_r('w3') ->> 'work_id',
        (select string_agg(e ->> 'id', ',') from jsonb_array_elements(tests._220_r('wc8')) e)
            = tests._220_r('w4') ->> 'work_id'),
    't|t',
    'p_limit bounds a claim, the earliest due first; a row not due yet is not claimed');

-- Finished and open rows, 6 and 8 days after their last change (an insert
-- sets updated_at freely; only an update runs set_updated_at).
insert into public.whatsapp_inbound_work (org_id, message_id, kind, state, created_at, updated_at) values
    (tests.org_a(), (tests._220_r('w1') ->> 'message_id')::uuid, 'flow', 'done',
     now() - interval '9 days', now() - interval '8 days'),
    (tests.org_a(), (tests._220_r('w4') ->> 'message_id')::uuid, 'flow', 'failed',
     now() - interval '9 days', now() - interval '8 days'),
    (tests.org_a(), (tests._220_r('w5') ->> 'message_id')::uuid, 'flow', 'done',
     now() - interval '7 days', now() - interval '6 days'),
    (tests.org_a(), (tests._220_r('w3') ->> 'message_id')::uuid, 'media', 'pending',
     now() - interval '9 days', now() - interval '8 days');
select public.cleanup_old_inbound_work();
select is(
    (select string_agg(format('%s/%s/%s', w.kind, w.state, extract(day from now() - w.updated_at)::int), ','
                       order by w.updated_at)
       from public.whatsapp_inbound_work w where w.org_id = tests.org_a() and w.updated_at < now()),
    'media/pending/8,flow/done/6',
    'the cleanup deletes done and failed work older than 7 days and keeps newer or open work');

update public.whatsapp_inbound_work set steps = '{"lead": true}'
 where org_id = tests.org_a() and kind = 'flow' and state = 'done';
select is(
    (select w.updated_at = now() from public.whatsapp_inbound_work w
      where w.org_id = tests.org_a() and w.kind = 'flow' and w.state = 'done'),
    true,
    'every update moves updated_at (set_updated_at), so the 7 days count from the last change');

select is(
    (select count(*)::int from public.whatsapp_inbound_work w
      where w.message_id = (tests._220_r('w1') ->> 'message_id')::uuid),
    1,
    'precondition: the contact''s message has a work row');
select tests.authenticate_as(tests.user_a1());
select is(public.delete_contact_cascade(tests.org_a(), '620022000801') ->> 'deleted', 'true',
    'an org member deletes the contact (delete_contact_cascade, 0047)');
select tests.authenticate_as_service_role();
select is(
    (select count(*)::int from public.whatsapp_inbound_work w
      where w.message_id = (tests._220_r('w1') ->> 'message_id')::uuid),
    0,
    'and the work row goes with the message (on delete cascade)');

select throws_ok(
    format('insert into public.whatsapp_inbound_work (org_id, message_id, kind) values (%L, %L, %L)',
           tests.org_a(), tests._220_r('w3') ->> 'message_id', 'flow'),
    '23505', null,
    'one work row of a kind per message (the unique key leads with org_id)');
select throws_ok(
    format('insert into public.whatsapp_inbound_work (org_id, message_id, kind) values (%L, %L, %L)',
           tests.org_a(), tests._220_r('w3') ->> 'message_id', 'audio'),
    '23514', null,
    'the kind is media or flow');

-- ---------------------------------------------------------------------------
-- 11. Members and anon: no access to the work rows, no call of the functions
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_a1());
select * from tests.check_no_privilege('whatsapp_inbound_work',
    'org_id, message_id, kind', $$ tests.org_a(), gen_random_uuid(), 'media' $$,
    $$ state = 'done' $$, 'a member of org A');
select tests.authenticate_as(tests.user_b1());
select * from tests.check_no_privilege('whatsapp_inbound_work',
    'org_id, message_id, kind', $$ tests.org_b(), gen_random_uuid(), 'media' $$,
    $$ state = 'done' $$, 'a member of org B');
select tests.authenticate_as_anon();
select * from tests.check_anon_denied('whatsapp_inbound_work',
    'org_id, message_id, kind', $$ tests.org_a(), gen_random_uuid(), 'media' $$,
    $$ state = 'done' $$);

select tests.authenticate_as(tests.user_a1());
select throws_ok(
    $$ select * from public.wa_ingest_inbound(tests.org_a(), '620022000901', null, 'wamid.220.x', null,
           'x', 'x', null, null, null, null, null, '{}', true, null, null, false, null, null, null, null) $$,
    '42501', 'permission denied for function wa_ingest_inbound',
    'an org member cannot call wa_ingest_inbound');
select throws_ok(
    $$ select * from public.claim_inbound_work(10, 120, null) $$,
    '42501', 'permission denied for function claim_inbound_work',
    'nor claim the work');
select tests.clear_authentication();

select * from finish();
rollback;
