-- Fase 1 — org Realtime bus, EXPAND phase (tracker 1.9 / 1.14; audit KEA-15,
-- PER-8, KUA-13).
--
-- Why (KEA-15). The dashboard listens to postgres_changes on the 4 tables of
-- the supabase_realtime publication. realtime.apply_rls skips the RLS check
-- for DELETE events and sends the primary-key columns the subscriber's role
-- may SELECT, so every signed-in user of ANY org receives every org's deletes
-- (org_id + customer phone_number on whatsapp_chats and chat_labels). Filters
-- are picked by the client and DELETE events cannot be filtered, so they do
-- not isolate tenants. 0063 closed the anon-key variant; this migration adds
-- the replacement: one private Broadcast topic per org, 'org:<org uuid>',
-- that only members of that org can join (Realtime Authorization), fed by
-- database triggers. Clients refetch the rows through PostgREST, under RLS.
-- PER-8: one message per org per statement instead of one postgres_changes
-- event per row per subscriber, and orders (Bookings) becomes live.
--
--   1. private.realtime_topic_org_id(text): the org uuid of a topic
--      'org:<uuid>' (either letter case), else null (never a cast error);
--   2. policy "org members receive org broadcasts" on realtime.messages:
--      SELECT for authenticated on a broadcast row whose topic IS the topic
--      being joined (realtime.topic()), if the caller is a member of the org
--      that topic names. Realtime authorizes a private join by setting the
--      caller's role/claims and realtime.topic, then reading back, under RLS,
--      a probe row it inserted with that topic (replay filters by topic too),
--      so the equality holds for every row Realtime needs. The topic equality
--      is required: realtime.send runs SET LOCAL realtime.topic, so the
--      setting stays for the rest of a writer's transaction, and without the
--      equality a member who just wrote to their own org could read every
--      org's broadcast rows in that transaction. is_org_member(null) is false,
--      so a missing or malformed topic gets nothing. There is deliberately NO
--      insert/update/delete policy: clients can never send on these topics
--      (Realtime checks write access with an INSERT under RLS). Realtime
--      caches this decision per channel until the client sends a new JWT (at
--      most jwt_expiry, 3600 s): a member removed from the org keeps receiving
--      id/count signals until then, while row data still flows only through
--      PostgREST under RLS;
--   3. private.broadcast_org_changes(): statement-level trigger function, one
--      realtime.send per org touched by the statement;
--   4. 15 triggers trg_org_broadcast_ins / _upd / _del (AFTER INSERT / UPDATE /
--      DELETE ... FOR EACH STATEMENT) on whatsapp_chats, whatsapp_messages,
--      labels, chat_labels and orders.
--
-- Why this shape (pinned by 150_realtime_org_broadcast.test.sql and guard 12
-- of 070_catalog_guards.test.sql):
--   * SECURITY DEFINER, owner postgres (INSERT on realtime.messages, BYPASSRLS),
--     search_path '': realtime.send is SECURITY INVOKER and turns every error
--     into a WARNING, so an invoker trigger would silently drop the broadcast
--     of every authenticated write (no INSERT policy). EXECUTE is revoked from
--     every API role; firing a trigger needs none (as in 0023).
--   * realtime.send, not realtime.broadcast_changes: broadcast_changes raises
--     errors as EXCEPTION and refuses statement level. Each send also runs in
--     its own BEGIN ... EXCEPTION block, so Realtime can never abort a webhook
--     or dashboard write: the worst case is a WARNING and a missed live update
--     (the client resyncs, the polls stay).
--   * statement level with transition tables: delete_contact_cascade (0047),
--     a label delete (cascades to chat_labels) and markChatRead change many
--     rows in one statement and would otherwise send one message per row.
--     PostgreSQL refuses transition tables on multi-event triggers, hence one
--     trigger per event. An UPDATE that matches no row sends nothing. A
--     single-row upsert sends one message (only one of its two statement
--     triggers has rows); a multi-row upsert that inserts some rows and
--     updates others sends one INSERT and one UPDATE message per org.
--   * the 50-id cap bounds the payload, not the work: every transition row is
--     serialized once (to_jsonb) and all its ids are aggregated before the
--     slice. Negligible for the webhook/dashboard statements (one or a few
--     rows); keep it in mind for maintenance-scale statements (a backfill
--     UPDATE over a whole table also sends one message per org).
--   * no phone number and no message text in the payload: realtime.messages
--     keeps rows for about 3 days and delete_contact_cascade cannot purge it.
--
-- Payload contract v1 (the org-bus client parses exactly this; a breaking
-- change needs "v": 2):
--   topic    'org:' || org_id (lower-case uuid text), private = true
--   event    the table name: whatsapp_chats | whatsapp_messages | labels |
--            chat_labels | orders
--   payload  {"v": 1, "table": <event>, "op": "INSERT" | "UPDATE" | "DELETE",
--             "n": <rows of that org in the statement, >= 1>,
--             "ids": [<at most 50 values of the table's id column, as text,
--                      in no particular order>]}
--            plus "id" (the message uuid), which realtime.send adds.
--            whatsapp_chats and chat_labels have composite keys holding the
--            phone number, so their ids are always []. n > length(ids) means
--            "refetch what you show".
--
-- Deploy order: apply BEFORE deploying the client PR that joins the org
-- topics (OrgRealtimeProvider, rest of tracker 1.9). The code on main never
-- joins them, so it is unaffected; it keeps postgres_changes until the
-- contract migration (0068, applied after that deploy) empties
-- supabase_realtime. This expand step alone closes nothing: until 0068 the
-- DELETE keys still reach every org over postgres_changes (KEA-15 stays open,
-- no second tenant with real data). Production already has everything this
-- needs (read-only check 2026-10-16): realtime.messages (partitioned, RLS on,
-- 0 policies), realtime.send / realtime.topic with the same bodies as the
-- local replay, INSERT and BYPASSRLS for postgres, USAGE on schema private
-- for authenticated, and supautils.policy_grants lets postgres create
-- policies on realtime.messages.
--
-- Rollback (safe at any time: before the client PR is live nothing reads
-- these topics; afterwards only ChatList and ChatWindow keep polling, the
-- other live views and the in-tab alerts pause until the triggers are back):
--   for t in whatsapp_chats, whatsapp_messages, labels, chat_labels, orders:
--     drop trigger trg_org_broadcast_ins on public.<t>;
--     drop trigger trg_org_broadcast_upd on public.<t>;
--     drop trigger trg_org_broadcast_del on public.<t>;
--   drop function private.broadcast_org_changes();
--   drop policy "org members receive org broadcasts" on realtime.messages;
--   drop function private.realtime_topic_org_id(text);
-- Then refresh fingerprint/production.txt.
-- Once a SECOND tenant has real data, the contract migration 0068 must never
-- be rolled back by re-adding tables to supabase_realtime: every signed-in
-- user of every org would receive the other orgs' DELETE keys again (KEA-15).
-- Degrade to polling instead (revert only the failing client build; ChatList
-- and ChatWindow keep their polls), or first close the tenant-2 gate again
-- (suspend the other tenants' access). See supabase/README.md, "Contract
-- migrations".
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

-- ---------------------------------------------------------------------------
-- 1. topic helper
-- ---------------------------------------------------------------------------
create function private.realtime_topic_org_id(p_topic text)
returns uuid
language sql
immutable
set search_path = ''
as $function$
    -- Cast only a well-formed uuid (the regex of 0058), so a malformed topic
    -- is null, never an error that would fail the join query.
    select case
        when p_topic ~* '^org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then substr(p_topic, 5)::uuid
    end;
$function$;

-- The policy below runs as authenticated (USAGE on schema private since 0029).
revoke all on function private.realtime_topic_org_id(text) from public, anon;
grant execute on function private.realtime_topic_org_id(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. receive-only policy on realtime.messages
-- ---------------------------------------------------------------------------
create policy "org members receive org broadcasts" on realtime.messages
    for select
    to authenticated
    using (
        extension = 'broadcast'
        and topic = (select realtime.topic())
        and private.is_org_member(private.realtime_topic_org_id((select realtime.topic())))
    );

-- ---------------------------------------------------------------------------
-- 3. statement-level broadcaster
-- ---------------------------------------------------------------------------
create function private.broadcast_org_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
    v_groups jsonb;
    v_group  jsonb;
begin
    -- The statement's rows grouped by org: row count and at most 50 ids (in
    -- no particular order). Each row is converted once with to_jsonb, so the
    -- same body serves the tables with an id column and those without one
    -- (ids = []).
    if tg_op = 'DELETE' then
        select jsonb_agg(g) into v_groups
        from (
            select j ->> 'org_id' as org_id,
                   count(*) as n,
                   coalesce((array_agg(j ->> 'id') filter (where j ? 'id'))[1:50], '{}') as ids
            from old_rows t, lateral to_jsonb(t) j
            group by 1
        ) g
        where g.org_id is not null;
    else
        select jsonb_agg(g) into v_groups
        from (
            select j ->> 'org_id' as org_id,
                   count(*) as n,
                   coalesce((array_agg(j ->> 'id') filter (where j ? 'id'))[1:50], '{}') as ids
            from new_rows t, lateral to_jsonb(t) j
            group by 1
        ) g
        where g.org_id is not null;
    end if;

    for v_group in select jsonb_array_elements(coalesce(v_groups, '[]'::jsonb))
    loop
        -- Never let Realtime abort the write that fired the trigger.
        begin
            perform realtime.send(
                jsonb_build_object(
                    'v', 1,
                    'table', tg_table_name::text,
                    'op', tg_op,
                    'n', (v_group ->> 'n')::integer,
                    'ids', v_group -> 'ids'),
                tg_table_name::text,
                'org:' || (v_group ->> 'org_id'),
                true);
        exception when others then
            raise warning 'broadcast_org_changes(%, %): %', tg_table_name, tg_op, sqlerrm;
        end;
    end loop;

    return null;
end;
$function$;

-- Fired by the triggers below as its owner; no API role may call it.
revoke all on function private.broadcast_org_changes() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. one trigger per table and event (transition tables need single-event
--    triggers)
-- ---------------------------------------------------------------------------
do $$
declare
    t text;
begin
    foreach t in array array[
        'whatsapp_chats', 'whatsapp_messages', 'labels', 'chat_labels', 'orders'
    ]
    loop
        execute format(
            'create trigger trg_org_broadcast_ins after insert on public.%I '
            'referencing new table as new_rows for each statement '
            'execute function private.broadcast_org_changes()', t);
        execute format(
            'create trigger trg_org_broadcast_upd after update on public.%I '
            'referencing new table as new_rows for each statement '
            'execute function private.broadcast_org_changes()', t);
        execute format(
            'create trigger trg_org_broadcast_del after delete on public.%I '
            'referencing old table as old_rows for each statement '
            'execute function private.broadcast_org_changes()', t);
    end loop;
end $$;
