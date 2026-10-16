-- Org Realtime bus (migration 0064; tracker 1.9 / 1.14, audit KEA-15 / PER-8 /
-- KUA-13): every write to whatsapp_chats, whatsapp_messages, labels,
-- chat_labels and orders sends ONE minimal private broadcast per org and
-- statement on topic 'org:<org uuid>', and only members of that org can read
-- (join) it.
--   1. catalog (always): realtime schema present, topic helper truth table,
--      exactly one receive-only policy on realtime.messages, the broadcaster is
--      SECURITY DEFINER with search_path '' (EXECUTE grants: 050), the 15
--      statement-level triggers;
--   2. precondition, never skipped: realtime.messages has the partition of
--      today (UTC). `db start` / `db reset` create yesterday .. +3 days, and
--      without one every broadcast is only a WARNING. So a CLI bump or config
--      change that stops initialising Realtime fails CI here instead of
--      silently skipping 3. Locally: `npx supabase db reset`;
--   3. behaviour (skipped only when 2 failed): what member, cascade and
--      service-role writes send; that a member reads only their own org's rows
--      even after realtime.send left realtime.topic set in the transaction;
--      the join check Realtime runs (probe rows + realtime.topic + role) and
--      that clients cannot send.
begin;
select plan(48);

select tests.create_two_orgs();

-- Fixtures as postgres: the same customer phone in both orgs, a label in org A.
insert into public.whatsapp_chats (org_id, phone_number) values
    (tests.org_a(), '628111'),
    (tests.org_b(), '628111');
insert into public.labels (id, org_id, name) values
    ('aaaaaaaa-1abe-4000-8000-00000000000a', tests.org_a(), 'Label A');

-- ---------------------------------------------------------------------------
-- 1. Catalog
-- ---------------------------------------------------------------------------
select has_table('realtime', 'messages', 'realtime.messages exists (Realtime schema initialised)');
select has_function('realtime', 'send', array['jsonb', 'text', 'text', 'boolean'],
    'realtime.send(jsonb, text, text, boolean) exists');
select has_function('realtime', 'topic', array[]::name[], 'realtime.topic() exists');

select is(private.realtime_topic_org_id(v.topic), v.expected, 'topic helper: ' || v.label)
from (values
    ('org:' || tests.org_a()::text,          tests.org_a(), 'org:<uuid> gives the uuid'),
    ('org:' || upper(tests.org_a()::text),   tests.org_a(), 'org:<upper-case uuid> gives the uuid'),
    ('org:not-a-uuid',                       null,          'org:not-a-uuid gives null'),
    ('org:',                                 null,          'org: without a uuid gives null'),
    ('',                                     null,          'the empty topic gives null'),
    (null,                                   null,          'a null topic gives null'),
    ('org:' || tests.org_a()::text || ':x',  null,          'org:<uuid>:x gives null'),
    (tests.org_a()::text,                    null,          'a bare uuid gives null'),
    ('x-org:' || tests.org_a()::text,        null,          'text before org: gives null'),
    ('org:' || tests.org_a()::text || E'\n', null,          'a trailing newline gives null')
) as v(topic, expected, label);

select policies_are('realtime', 'messages', array['org members receive org broadcasts'],
    'realtime.messages has exactly one policy');
select policy_cmd_is('realtime', 'messages', 'org members receive org broadcasts', 'SELECT',
    'the policy is SELECT only: no INSERT/UPDATE/DELETE policy, clients cannot send');
select policy_roles_are('realtime', 'messages', 'org members receive org broadcasts', array['authenticated'],
    'the policy applies to authenticated only');

select is((select prosecdef from pg_proc where oid = 'private.broadcast_org_changes()'::regprocedure), true,
    'the broadcaster is SECURITY DEFINER (an invoker trigger silently drops authenticated writes)');
select is((select proconfig from pg_proc where oid = 'private.broadcast_org_changes()'::regprocedure),
    array['search_path=""'],
    'the broadcaster pins search_path to the empty string');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.broadcast_org_changes()'::regprocedure),
    'postgres',
    'the broadcaster is owned by postgres (INSERT on realtime.messages, BYPASSRLS)');

-- (name columns have collation "C": compared as default-collation text)
select results_eq(
    $$ select c.relname::text collate "default", t.tgname::text collate "default",
              case when t.tgtype & 4 <> 0 then 'INSERT'
                   when t.tgtype & 16 <> 0 then 'UPDATE'
                   when t.tgtype & 8 <> 0 then 'DELETE' end,
              t.tgtype & 1 = 0 and t.tgtype & 2 = 0 and t.tgtype & 64 = 0,
              coalesce(t.tgnewtable, t.tgoldtable)::text collate "default",
              t.tgenabled::text
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       where t.tgfoid = 'private.broadcast_org_changes()'::regprocedure
       order by 1, 2 $$,
    $$ select tb, 'trg_org_broadcast_' || e.suffix, e.event, true, e.transition, 'O'
       from unnest(array['chat_labels', 'labels', 'orders', 'whatsapp_chats', 'whatsapp_messages']) tb,
            (values ('del', 'DELETE', 'old_rows'),
                    ('ins', 'INSERT', 'new_rows'),
                    ('upd', 'UPDATE', 'new_rows')) e(suffix, event, transition)
       order by 1, 2 $$,
    'the broadcaster fires from exactly 15 enabled AFTER ... FOR EACH STATEMENT triggers: '
    'INSERT / UPDATE / DELETE on the 5 bus tables, each with its transition table');

-- ---------------------------------------------------------------------------
-- 2. Precondition (never skipped)
-- ---------------------------------------------------------------------------
select ok(tests.realtime_partition_ready(),
    'precondition: realtime.messages has the partition of today (UTC), created by db start / db reset '
    '(if this fails locally, run npx supabase db reset)');

-- ---------------------------------------------------------------------------
-- 3. Behaviour
-- ---------------------------------------------------------------------------

-- Messages are told apart by id, not by time: realtime.send leaves
-- inserted_at to the column default, which is now() (the transaction start)
-- in production and clock_timestamp() only in newer Realtime images, so a
-- time window inside this one transaction would depend on the image.
-- The ids of the messages on the two fixture orgs' topics so far. SECURITY
-- DEFINER (owner postgres, BYPASSRLS): it is called while a member is
-- authenticated, and RLS would hide the earlier messages from that member.
create function tests._150_seen() returns text[]
language sql
security definer
set search_path = ''
as $$
    select coalesce(array_agg(m.id::text), '{}')
    from realtime.messages m
    where m.topic in ('org:' || tests.org_a()::text, 'org:' || tests.org_b()::text);
$$;

-- The messages on those topics that are not in p_seen, one sorted line each:
-- '<A|B> <event> <op> n=<n> ids=<k>'. Call as postgres (BYPASSRLS).
create function tests._150_sent_after(p_seen text[]) returns text[]
language sql
as $$
    select coalesce(array_agg(line order by line), '{}')
    from (
        select format('%s %s %s n=%s ids=%s',
                      case m.topic when 'org:' || tests.org_a()::text then 'A' else 'B' end,
                      m.event, m.payload ->> 'op', m.payload ->> 'n',
                      jsonb_array_length(m.payload -> 'ids')) as line
        from realtime.messages m
        where not (m.id::text = any (p_seen))
          and m.topic in ('org:' || tests.org_a()::text, 'org:' || tests.org_b()::text)
    ) s;
$$;

-- The behaviour assertions (27) need today's partition: skipped as a block
-- when the precondition above failed, so the file reports one clear failure.
create function tests._150_behaviour() returns setof text
language plpgsql
as $$
declare
    v_a     text := 'org:' || tests.org_a()::text;
    v_b     text := 'org:' || tests.org_b()::text;
    v_seen  text[];
    v_ids   text[];
    v_msg   realtime.messages;
    v_n     integer;
    v_level text;
begin
    if not tests.realtime_partition_ready() then
        return next skip('no realtime.messages partition for today (see the precondition)', 27);
        return;
    end if;

    -- A. A member's 2-row insert: ONE message, on the writer's org topic.
    perform tests.authenticate_as(tests.user_a1());
    v_seen := tests._150_seen();
    with ins as (
        insert into public.whatsapp_messages (org_id, phone_number, role, content)
        values (tests.org_a(), '628111', 'user', 'satu'),
               (tests.org_a(), '628111', 'user', 'dua')
        returning id
    )
    select array_agg(id::text order by id::text) into v_ids from ins;
    perform tests.clear_authentication();

    return next is(tests._150_sent_after(v_seen), array['A whatsapp_messages INSERT n=2 ids=2'],
        'a member''s 2-row insert sends ONE message, on its own org''s topic (none on org B)');
    select m.* into v_msg from realtime.messages m
    where not (m.id::text = any (v_seen)) and m.topic = v_a;
    return next ok(v_msg.extension = 'broadcast' and v_msg.private,
        'it is a private broadcast message');
    return next is(array(select jsonb_object_keys(v_msg.payload) order by 1),
        array['id', 'ids', 'n', 'op', 'table', 'v'],
        'payload v1 has only v, table, op, n, ids (+ the id realtime.send adds): no phone, no text');
    return next is(v_msg.payload - 'id' - 'ids',
        '{"v": 1, "table": "whatsapp_messages", "op": "INSERT", "n": 2}'::jsonb,
        'payload: v = 1, table = the event, op = INSERT, n = 2');
    return next is(array(select jsonb_array_elements_text(v_msg.payload -> 'ids') order by 1), v_ids,
        'payload: ids are exactly the 2 inserted message ids');

    -- B. Updates: no row, no message; one row, one message without the phone.
    perform tests.authenticate_as(tests.user_a1());
    v_seen := tests._150_seen();
    update public.whatsapp_chats set unread_count = 0 where unread_count > 0;
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen), '{}'::text[],
        'an UPDATE that matches no row (markChatRead on a read chat) sends nothing');

    perform tests.authenticate_as(tests.user_a1());
    v_seen := tests._150_seen();
    update public.whatsapp_chats set notes = 'catatan' where phone_number = '628111';
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen), array['A whatsapp_chats UPDATE n=1 ids=0'],
        'a member''s 1-row update sends one message; whatsapp_chats ids are [] (its key holds the phone)');
    select m.* into v_msg from realtime.messages m
    where not (m.id::text = any (v_seen)) and m.topic = v_a;
    return next ok(strpos(v_msg.payload::text, '628111') = 0,
        'the payload does not carry the phone number');

    -- C. One statement touching two orgs: one message per org.
    perform tests.authenticate_as_service_role();
    v_seen := tests._150_seen();
    update public.whatsapp_chats set notes = 'semua' where phone_number = '628111';
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen),
        array['A whatsapp_chats UPDATE n=1 ids=0', 'B whatsapp_chats UPDATE n=1 ids=0'],
        'a statement that touches two orgs sends one message to each org');

    -- D. Labels: a chat_labels insert, then a label delete that cascades.
    perform tests.authenticate_as(tests.user_a1());
    v_seen := tests._150_seen();
    insert into public.chat_labels (org_id, phone_number, label_id)
    values (tests.org_a(), '628111', 'aaaaaaaa-1abe-4000-8000-00000000000a');
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen), array['A chat_labels INSERT n=1 ids=0'],
        'assigning a label sends one chat_labels message');

    perform tests.authenticate_as(tests.user_a1());
    v_seen := tests._150_seen();
    delete from public.labels where id = 'aaaaaaaa-1abe-4000-8000-00000000000a';
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen),
        array['A chat_labels DELETE n=1 ids=0', 'A labels DELETE n=1 ids=1'],
        'deleting a label sends a labels DELETE and, for the FK cascade, one chat_labels DELETE');

    -- E. delete_contact_cascade (0047, SECURITY DEFINER): one message per table.
    perform tests.authenticate_as(tests.user_a1());
    v_seen := tests._150_seen();
    perform public.delete_contact_cascade(tests.org_a(), '628111');
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen),
        array['A whatsapp_chats DELETE n=1 ids=0', 'A whatsapp_messages DELETE n=2 ids=2'],
        'delete_contact_cascade sends one whatsapp_messages DELETE and one whatsapp_chats DELETE');

    -- F. Service-role writers (webhook, queue, AI tools) broadcast too.
    perform tests.authenticate_as_service_role();
    v_seen := tests._150_seen();
    insert into public.whatsapp_chats (org_id, phone_number) values (tests.org_b(), '628222');
    insert into public.orders (org_id, customer_phone, customer_name)
    values (tests.org_b(), '628222', 'Pelanggan B');
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen),
        array['B orders INSERT n=1 ids=1', 'B whatsapp_chats INSERT n=1 ids=0'],
        'service-role inserts into whatsapp_chats and orders each send one message on the row''s org');

    perform tests.authenticate_as_service_role();
    v_seen := tests._150_seen();
    insert into public.whatsapp_chats (org_id, phone_number, contact_name)
    values (tests.org_b(), '628222', 'Budi')
    on conflict (org_id, phone_number) do update set contact_name = excluded.contact_name;
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen), array['B whatsapp_chats UPDATE n=1 ids=0'],
        'an upsert sends exactly one message (only one of its two statement triggers has rows)');

    perform tests.authenticate_as_service_role();
    v_seen := tests._150_seen();
    insert into public.whatsapp_messages (org_id, phone_number, role, content)
    select tests.org_b(), '628222', 'user', 'pesan ' || g from generate_series(1, 51) g;
    perform tests.clear_authentication();
    return next is(tests._150_sent_after(v_seen), array['B whatsapp_messages INSERT n=51 ids=50'],
        'a 51-row statement sends n = 51 with at most 50 ids');

    -- G. Cross-org read: realtime.send left realtime.topic = the writer's org.
    select count(*)::int into v_n from realtime.messages where topic = v_b;
    return next ok(v_n > 0, 'precondition: org B broadcast rows exist in this transaction');
    perform tests.authenticate_as(tests.user_a1());
    insert into public.whatsapp_chats (org_id, phone_number) values (tests.org_a(), '628333');
    return next is(current_setting('realtime.topic', true), v_a,
        'after a write, realtime.topic stays set to the writer''s org for the rest of the transaction');
    return next results_eq(
        'select distinct topic from realtime.messages',
        array[v_a],
        'a member who just wrote reads only its own org''s rows, with no topic filter (policy binds topic = realtime.topic())');
    perform tests.clear_authentication();

    -- H. Join simulation: Realtime inserts a probe row for the joined topic,
    --    then reads it as the caller with realtime.topic set.
    insert into realtime.messages (topic, extension, private, event, payload) values
        (v_a, 'broadcast', true, 'probe', '{}'),
        (v_b, 'broadcast', true, 'probe', '{}'),
        ('org:not-a-uuid', 'broadcast', true, 'probe', '{}');

    perform tests.realtime_join_as(tests.user_a1(), v_a);
    return next results_eq($q$ select topic from realtime.messages where event = 'probe' $q$, array[v_a],
        'join: a1 joining org A reads org A''s probe row only (join allowed)');
    perform tests.realtime_join_as(tests.user_a2(), v_a);
    return next results_eq($q$ select topic from realtime.messages where event = 'probe' $q$, array[v_a],
        'join: a2 (staff of org A) joining org A reads it too');
    perform tests.realtime_join_as(tests.user_a1(), v_b);
    return next is_empty($q$ select 1 from realtime.messages where event = 'probe' $q$,
        'join: a1 joining org B reads nothing (join refused)');
    perform tests.realtime_join_as(tests.user_b1(), v_a);
    return next is_empty($q$ select 1 from realtime.messages where event = 'probe' $q$,
        'join: b1 joining org A reads nothing (join refused)');
    perform tests.realtime_join_as(null, v_a);
    return next is_empty($q$ select 1 from realtime.messages where event = 'probe' $q$,
        'join: anon joining org A reads nothing');
    perform tests.realtime_join_as(tests.user_a1(), 'org:not-a-uuid');
    return next is_empty($q$ select 1 from realtime.messages where event = 'probe' $q$,
        'join: a malformed topic reads nothing (and raises no cast error)');
    perform tests.realtime_join_as(tests.user_a1(), null);
    return next is_empty($q$ select 1 from realtime.messages where event = 'probe' $q$,
        'join: without a topic nothing is readable');

    -- I. Clients cannot send.
    perform tests.realtime_join_as(tests.user_a1(), v_a);
    return next throws_ok(
        format($q$ insert into realtime.messages (topic, extension, private, event, payload)
                   values (%L, 'broadcast', true, 'client', '{}') $q$, v_a),
        '42501', 'new row violates row-level security policy for table "messages"',
        'a member cannot send on its own org topic (no INSERT policy)');
    -- realtime.send reports the RLS refusal as a WARNING only; keep it out of
    -- the test output.
    v_level := current_setting('client_min_messages');
    perform set_config('client_min_messages', 'error', true);
    perform realtime.send('{"probe": true}'::jsonb, 'client', v_a, true);
    perform set_config('client_min_messages', v_level, true);
    perform tests.clear_authentication();
    return next is((select count(*)::int from realtime.messages where event = 'client'), 0,
        'realtime.send as a member writes nothing: why the broadcaster is SECURITY DEFINER');
end;
$$;

select * from tests._150_behaviour();

select * from finish();
rollback;
