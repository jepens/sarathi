-- Tracker 2.2a part 2 (PR-C2; design of 2026-10-30, owner decisions D23):
-- atomic ingest of inbound WhatsApp messages. The webhook used to write one
-- inbound message in several independent requests (rate slot, chat row,
-- message row, chat summary and unread count, quota unit, queue job). A
-- failure in the middle left a partial write that Meta's resend of a 503 could
-- not repair (the message row existed, so the resend was a duplicate and the
-- customer never got an AI reply) or repeated (a second rate slot, quota unit
-- or push). Now one call per message writes all of it in one transaction
-- behind one redelivery gate, so a 503 lets Meta's resend do the work exactly
-- once.
--
-- public.whatsapp_messages.wa_timestamp: Meta's time of an inbound message
-- (messages[].timestamp, never later than its arrival), written by
-- wa_ingest_inbound. For the audit, the late-message policy (no AI reply 20 h
-- or more after the customer sent it, D23) and the work horizons; never an
-- ordering key: created_at stays the arrival time that the inbox, the AI
-- history and the queue debounce sort on.
--
-- public.whatsapp_inbound_work: durable follow-up work of a stored message (a
-- media download, a Flow's follow-ups), written in the same transaction as the
-- message. Used from PR-C3; it ships now so that the signature of
-- wa_ingest_inbound never changes. claim_inbound_work() leases due rows (FOR
-- UPDATE SKIP LOCKED, one attempt per claim) and returns the rows whose lease
-- ran out on their last attempt as failed; cleanup_old_inbound_work() deletes
-- finished rows after 7 days (the payload, which can hold Flow answers, is
-- cleared by the worker when the work ends, D11). A row dies with its message
-- (on delete cascade), so delete_contact_cascade (0047) removes it too.
--
-- public.wa_ingest_inbound(...): one transaction per inbound message, under a
-- per-contact advisory lock: contact key (the chat holding the BSUID, else the
-- phone, else the BSUID), redelivery gate (the user row of this wamid: nothing
-- is written), rate limit (the decision and identifiers of checkRateLimit in
-- lib/whatsapp/rate-limiter-db.ts, which it replaces; fails open), chat row,
-- message row, chat summary from Meta's time (forward only), BSUID, work row,
-- then the AI decision: AI off for the chat, a job of this wamid already
-- queued, a burst of the chat still waiting in the queue (joined, no quota
-- unit), or one inbound_minute unit of consume_org_quota (0071, fails open)
-- and the queue job. Lock order: advisory lock, chat row, org counter row.
--
-- public.wa_apply_statuses(org, statuses): the delivery statuses of one
-- webhook change in one guarded statement, forward only (sent < delivered <
-- read; failed only over sent; delivered or read over failed only with a newer
-- Meta time), on the org's assistant rows only, plus the BSUID backfill of the
-- recipients.
--
-- Service role only: the work table has RLS on, the deny policy and no table
-- privilege for anon or authenticated (like 0069-0071), and the four functions
-- are executable by the service role only. They are SECURITY INVOKER: the
-- service role holds the table rights and bypasses RLS, and should EXECUTE
-- ever leak to authenticated, RLS would keep the chat and message writes in
-- the caller's own org while the deny policies refuse the queue, rate-limit
-- and work rows.
--
-- Expand: the code on main (PR-C1) never calls these objects; applied after
-- the owner's review (D1) and before the PR-C2 deploy. Rollback = revert the
-- build: the older code ignores the new column, table and functions, so 0072
-- stays and no data SQL is needed (the older AI history does read the rows
-- PR-C2 marks metadata.unprocessable as customer lines: count them before a
-- revert; few are expected). Dropping any of them would be a contract
-- migration of its own, never a rollback step.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

-- Never queue behind a long transaction on whatsapp_messages.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Meta's message time
-- ---------------------------------------------------------------------------

-- Nullable without a default: a catalog-only change, no table rewrite.
alter table public.whatsapp_messages add column wa_timestamp timestamptz;
comment on column public.whatsapp_messages.wa_timestamp is
    'messages[].timestamp (clamped) of inbound rows written by wa_ingest_inbound; created_at stays the arrival time';
comment on column public.whatsapp_messages.wa_message_id is
    'Meta wamid, or syn.<sha256> for an inbound message Meta sent without an id (wa_ingest_inbound)';

-- ---------------------------------------------------------------------------
-- 2. Durable follow-up work (service role only, no realtime trigger)
-- ---------------------------------------------------------------------------

create table public.whatsapp_inbound_work (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references public.organizations (id) on delete cascade,
    message_id uuid not null references public.whatsapp_messages (id) on delete cascade,
    kind text not null,
    state text not null default 'pending',
    attempts integer not null default 0,
    max_attempts integer not null default 6,
    next_attempt_at timestamptz not null default now(),
    lease_until timestamptz,
    -- flow: {lead, stage, note, confirm: sending | sent | unknown | failed}
    steps jsonb not null default '{}'::jsonb,
    -- Cleared when the work ends (D11: it can hold a Flow's answers).
    payload jsonb not null default '{}'::jsonb,
    -- describeErrorForOps text only (codes and fixed texts, no personal data).
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint whatsapp_inbound_work_kind_check check (kind in ('media', 'flow')),
    constraint whatsapp_inbound_work_state_check check (state in ('pending', 'running', 'done', 'failed')),
    constraint whatsapp_inbound_work_max_attempts_check check (max_attempts between 1 and 20),
    constraint whatsapp_inbound_work_last_error_check check (char_length(last_error) <= 200),
    -- One work row of a kind per message, keyed per org (guard 13 of 070).
    constraint whatsapp_inbound_work_org_message_kind_key unique (org_id, message_id, kind)
);

-- The unique key leads with org_id and covers the org foreign key; this index
-- covers the message foreign key (the cascade from whatsapp_messages).
create index whatsapp_inbound_work_message_id_idx on public.whatsapp_inbound_work (message_id);
-- The claim scans the open rows by due time.
create index whatsapp_inbound_work_due_idx on public.whatsapp_inbound_work (next_attempt_at)
    where state in ('pending', 'running');

alter table public.whatsapp_inbound_work enable row level security;
revoke all on table public.whatsapp_inbound_work from anon, authenticated;
create policy "service_role only" on public.whatsapp_inbound_work
    as permissive for all to anon, authenticated
    using (false) with check (false);

create trigger trg_whatsapp_inbound_work_updated_at
    before update on public.whatsapp_inbound_work
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. The ingest: one transaction per inbound message
-- ---------------------------------------------------------------------------

-- outcome: 'new' (written), 'duplicate' (a user row with this wamid exists:
-- nothing written, nothing broadcast), 'rate_limited' (over the contact's
-- limit: only the rate count is written) or 'no_identity' (neither a phone nor
-- a BSUID: nothing written). contact_key: the key this call resolved (null
-- only for no_identity). queue_outcome, only when p_ai_eligible: 'queued',
-- 'joined' (a burst of the chat still waits in the queue: no quota unit),
-- 'already_queued' (a job with this wamid exists, e.g. of the old code path),
-- 'manual' (AI off for the chat) or 'refused' (the org's inbound_minute quota;
-- the message is stored all the same). quota_limit and quota_first_refusal:
-- the answer of consume_org_quota, when it was asked. rate_first: this call
-- is the first refusal of the contact's window (the one to warn about).
-- rate_error and quota_error: the SQLSTATE of a rate or quota step that
-- failed open. work_id and work_state: the work row written by this call, or,
-- for a duplicate, the open (pending or running) work row of the stored
-- message.
--
-- 22004 and 22023 for invalid parameters (permanent for the webhook); their
-- texts name the parameter only, never a phone number, BSUID or message text.
-- Any other error aborts the whole call, so nothing of it stays written, and
-- is retryable (55P03 after lock_timeout, 40001, 23503 for a chat deleted in
-- between).
create function public.wa_ingest_inbound(
    p_org uuid, p_from text, p_bsuid text, p_wamid text, p_wa_ts timestamptz,
    p_content text, p_preview text, p_verified_phone text, p_reply_to_wamid text,
    p_media_type text, p_media_mime text, p_media_filename text, p_metadata jsonb,
    p_unread boolean, p_rate_scope text, p_rate_max integer,
    p_ai_eligible boolean, p_queue_text text, p_inbound_limit integer,
    p_work_kind text, p_work_payload jsonb)
returns table (outcome text, contact_key text, message_id uuid, chat_created boolean,
    summary_applied boolean, contact_name text, ai_enabled boolean, queue_outcome text,
    quota_limit integer, quota_first_refusal boolean, quota_error text,
    rate_first boolean, rate_error text, bsuid_conflict boolean, work_id uuid, work_state text)
language plpgsql
volatile
security invoker
set search_path = ''
set lock_timeout = '3s'
as $$
declare
    -- An empty phone or BSUID counts as missing.
    v_from text := nullif(p_from, '');
    v_bsuid text := nullif(p_bsuid, '');
    v_missing text;
    v_key text;
    v_count integer;
    v_chat_created boolean;
    v_message_id uuid;
    v_ts timestamptz;
    v_last_inbound timestamptz;
    v_ai_enabled boolean;
    v_contact_name text;
    v_apply boolean;
    v_work_id uuid;
    v_work_state text;
    v_joins boolean;
    v_allowed boolean;
    v_quota_limit integer;
    v_quota_first boolean;
    v_job_id uuid;
begin
    -- The SQL below uses only p_ parameters and v_ locals, and qualifies every
    -- column: the OUT names message_id, contact_name and ai_enabled are column
    -- names too. The OUT columns are set right before each return.
    chat_created := false;
    summary_applied := false;
    rate_first := false;
    bsuid_conflict := false;

    -- 0. Parameters.
    v_missing := concat_ws(', ',
        case when p_org is null then 'p_org' end,
        case when p_wamid is null then 'p_wamid' end,
        case when p_content is null then 'p_content' end,
        case when p_preview is null then 'p_preview' end,
        case when p_metadata is null then 'p_metadata' end,
        case when p_unread is null then 'p_unread' end,
        case when p_ai_eligible is null then 'p_ai_eligible' end,
        case when p_ai_eligible and p_queue_text is null then 'p_queue_text' end);
    if v_missing <> '' then
        raise exception 'wa_ingest_inbound: % must not be null', v_missing using errcode = '22004';
    end if;
    -- An empty key would make every later message without one a duplicate.
    if p_wamid = '' then
        raise exception 'wa_ingest_inbound: p_wamid must not be empty' using errcode = '22023';
    end if;
    if jsonb_typeof(p_metadata) <> 'object' then
        raise exception 'wa_ingest_inbound: p_metadata must be a JSON object' using errcode = '22023';
    end if;
    if p_rate_scope is not null and p_rate_scope not in ('main', 'other') then
        raise exception 'wa_ingest_inbound: p_rate_scope must be main, other or null' using errcode = '22023';
    end if;
    if p_rate_scope is not null and (p_rate_max is null or p_rate_max < 1) then
        raise exception 'wa_ingest_inbound: p_rate_max must be at least 1 with a rate scope' using errcode = '22023';
    end if;
    if p_ai_eligible and (p_inbound_limit is null or p_inbound_limit < 1) then
        raise exception 'wa_ingest_inbound: p_inbound_limit must be at least 1 when AI-eligible'
            using errcode = '22023';
    end if;
    if p_work_kind is not null and p_work_kind not in ('media', 'flow') then
        raise exception 'wa_ingest_inbound: p_work_kind must be media, flow or null' using errcode = '22023';
    end if;
    if p_media_type is not null and p_media_type not in ('image', 'document', 'audio', 'video') then
        raise exception 'wa_ingest_inbound: p_media_type must be image, document, audio, video or null'
            using errcode = '22023';
    end if;

    -- 1. Contact key: the chat of this org holding the BSUID, else the phone,
    --    else the BSUID itself (a contact Meta names only by its BSUID).
    if v_bsuid is not null then
        select c.phone_number into v_key
          from public.whatsapp_chats c
         where c.org_id = p_org and c.bsuid = v_bsuid;
    end if;
    v_key := coalesce(v_key, v_from, v_bsuid);
    if v_key is null then
        outcome := 'no_identity';
        return next;
        return;
    end if;
    contact_key := v_key;

    -- 2. One delivery per contact at a time (Meta's resend racing the original,
    --    the fragments of a burst), until the commit. Waits at most
    --    lock_timeout, then 55P03.
    perform pg_advisory_xact_lock(hashtextextended('wa_ingest:' || p_org::text || ':' || v_key, 0));

    -- 3. Redelivery gate: the user row of a wamid is never pruned.
    select m.id into v_message_id
      from public.whatsapp_messages m
     where m.org_id = p_org and m.wa_message_id = p_wamid and m.role = 'user';
    if v_message_id is not null then
        select w.id, w.state into v_work_id, v_work_state
          from public.whatsapp_inbound_work w
         where w.org_id = p_org and w.message_id = v_message_id and w.state in ('pending', 'running')
         order by w.created_at
         limit 1;
        outcome := 'duplicate';
        message_id := v_message_id;
        work_id := v_work_id;
        work_state := v_work_state;
        return next;
        return;
    end if;

    -- 4. Rate limit per contact, with the decision and identifiers of the
    --    checkRateLimit it replaces (lib/whatsapp/rate-limiter-db.ts): refused
    --    when p_rate_max messages are already counted in a window younger
    --    than 60 s. The count keeps rising while refused, so that rate_first
    --    marks the window's first refusal only. Fails open: any error lets
    --    the message through, with rate_error set.
    if p_rate_scope is not null then
        begin
            insert into public.rate_limits as r (identifier, request_count, window_start, updated_at)
            values (p_org::text || case p_rate_scope when 'other' then ':other:' else ':' end || v_key,
                    1, now(), now())
            on conflict (identifier) do update
                set request_count = case
                        when r.window_start is null or r.window_start < now() - interval '60 seconds' then 1
                        else r.request_count + 1
                    end,
                    window_start = case
                        when r.window_start is null or r.window_start < now() - interval '60 seconds' then now()
                        else r.window_start
                    end,
                    updated_at = now()
            returning r.request_count into v_count;
        exception when others then
            rate_error := sqlstate;
            v_count := null;
        end;
        if v_count > p_rate_max then
            outcome := 'rate_limited';
            rate_first := v_count = p_rate_max + 1;
            return next;
            return;
        end if;
    end if;

    -- 5 + 6. Chat row (an existing one stays as it is) and message row. Another
    --    delivery of this wamid under another contact key (the advisory lock
    --    is per key) can commit in between: then the message insert finds
    --    that row, the savepoint of this block undoes the chat this call
    --    inserted (and its broadcast), and the call answers 'duplicate'.
    --    The rate count of step 4 stays: one extra slot of the losing key,
    --    which has no chat (accepted; this race needs two keys for one wamid).
    begin
        insert into public.whatsapp_chats as c (org_id, phone_number, last_message_at)
        values (p_org, v_key, null)
        on conflict (org_id, phone_number) do nothing
        returning true into v_chat_created;

        insert into public.whatsapp_messages as m (
            org_id, phone_number, role, content, wa_message_id, reply_to_wamid,
            media_type, media_url, media_mime, media_filename, metadata, wa_timestamp)
        values (
            p_org, v_key, 'user', p_content, p_wamid, p_reply_to_wamid,
            p_media_type, null, p_media_mime, p_media_filename, p_metadata,
            case when p_wa_ts is not null then least(p_wa_ts, now()) end)
        on conflict (org_id, wa_message_id, role) where m.wa_message_id is not null do nothing
        returning m.id into v_message_id;

        if v_message_id is null then
            raise exception 'wa_ingest_inbound: another delivery stored this wamid' using errcode = 'WAI01';
        end if;
    exception when sqlstate 'WAI01' then
        v_chat_created := false;
    end;
    if v_message_id is null then
        select m.id into v_message_id
          from public.whatsapp_messages m
         where m.org_id = p_org and m.wa_message_id = p_wamid and m.role = 'user';
        select w.id, w.state into v_work_id, v_work_state
          from public.whatsapp_inbound_work w
         where w.org_id = p_org and w.message_id = v_message_id and w.state in ('pending', 'running')
         order by w.created_at
         limit 1;
        outcome := 'duplicate';
        message_id := v_message_id;
        work_id := v_work_id;
        work_state := v_work_state;
        return next;
        return;
    end if;
    chat_created := coalesce(v_chat_created, false);

    -- 7. Chat summary from Meta's time (never later than now(); none = now()),
    --    forward only: a message older than the chat's latest inbound keeps
    --    the preview and both stamps, and still counts as unread. Both stamps
    --    always get the same value. The message's foreign key already holds
    --    KEY SHARE on the row, so it cannot vanish here.
    v_ts := least(coalesce(p_wa_ts, now()), now());
    select c.last_inbound_at, c.ai_enabled, c.contact_name
      into v_last_inbound, v_ai_enabled, v_contact_name
      from public.whatsapp_chats c
     where c.org_id = p_org and c.phone_number = v_key
       for no key update;
    v_apply := v_last_inbound is null or v_last_inbound <= v_ts;
    update public.whatsapp_chats c
       set last_message = case when v_apply then p_preview else c.last_message end,
           last_message_at = case when v_apply then v_ts else c.last_message_at end,
           last_inbound_at = case when v_apply then v_ts else c.last_inbound_at end,
           unread_count = c.unread_count + case when p_unread then 1 else 0 end,
           verified_phone = coalesce(nullif(p_verified_phone, ''), c.verified_phone),
           updated_at = now()
     where c.org_id = p_org and c.phone_number = v_key;

    -- 8. BSUID on the chat. Held by another chat of the org (written by a
    --    concurrent call after the lookup of step 1): the message stays and
    --    the conflict is reported.
    if v_bsuid is not null then
        begin
            update public.whatsapp_chats c
               set bsuid = v_bsuid
             where c.org_id = p_org and c.phone_number = v_key
               and c.bsuid is distinct from v_bsuid;
        exception when unique_violation then
            bsuid_conflict := true;
        end;
    end if;

    -- 9. Follow-up work of the message (PR-C3: media download, Flow steps).
    if p_work_kind is not null then
        insert into public.whatsapp_inbound_work as w (org_id, message_id, kind, payload)
        values (p_org, v_message_id, p_work_kind, coalesce(p_work_payload, '{}'::jsonb))
        returning w.id, w.state into v_work_id, v_work_state;
    end if;

    -- 10. AI decision. Not serialised with claim_queue_jobs: a fragment that
    --     sees its burst still pending here while the drainer claims that
    --     burst is queued as 'joined' without a unit, and becomes a burst of
    --     its own (a second AI reply the minute quota does not count; the
    --     daily quota, ai_reply_day, still counts it). Accepted, as before.
    if p_ai_eligible then
        if not v_ai_enabled then
            queue_outcome := 'manual';
        elsif exists (select 1 from public.message_queue q
                       where q.org_id = p_org and q.wa_message_id = p_wamid) then
            -- A job of this wamid without its user row: the old code path.
            queue_outcome := 'already_queued';
        else
            v_joins := exists (select 1 from public.message_queue q
                                where q.org_id = p_org and q.phone_number = v_key and q.status = 'pending');
            v_allowed := true;
            if not v_joins then
                -- Fails open: any error lets the message through, with
                -- quota_error set.
                begin
                    select o.allowed, o.quota, o.first_refusal
                      into v_allowed, v_quota_limit, v_quota_first
                      from public.consume_org_quota(p_org, 'inbound_minute', p_inbound_limit) o;
                    v_allowed := coalesce(v_allowed, true);
                exception when others then
                    quota_error := sqlstate;
                    v_allowed := true;
                    v_quota_limit := null;
                    v_quota_first := null;
                end;
                quota_limit := v_quota_limit;
                quota_first_refusal := v_quota_first;
            end if;
            if v_allowed then
                -- created_at = now(): the debounce clock of claim_queue_jobs.
                insert into public.message_queue as q (org_id, phone_number, message_text, wa_message_id, status)
                values (p_org, v_key, p_queue_text, p_wamid, 'pending')
                on conflict (org_id, wa_message_id) where q.wa_message_id is not null do nothing
                returning q.id into v_job_id;
                queue_outcome := case
                    when v_job_id is null then 'already_queued'
                    when v_joins then 'joined'
                    else 'queued'
                end;
            else
                queue_outcome := 'refused';
            end if;
        end if;
    end if;

    -- 11. Done.
    outcome := 'new';
    message_id := v_message_id;
    summary_applied := v_apply;
    contact_name := v_contact_name;
    ai_enabled := v_ai_enabled;
    work_id := v_work_id;
    work_state := v_work_state;
    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Delivery statuses: set-based, forward only
-- ---------------------------------------------------------------------------

-- p_statuses: a JSON array of {id, status, ts (ISO text or null), error_code,
-- error_title, error_detail, recipient_id, recipient_user_id}. Elements that
-- are not objects, statuses other than sent / delivered / read / failed and
-- objects without an id are ignored. Per id the highest status counts (read >
-- delivered > failed > sent), on a tie the newest Meta time. applied: rows
-- updated; unknown_ids (sorted) and unknown: the ids with no assistant row in
-- the org (e.g. a status that arrived before its row); stale: the rest (an
-- older or equal status). The error fields are written for 'failed' and
-- cleared when delivered or read override a failed. bsuid_filled /
-- bsuid_conflicts: the recipients' BSUIDs written to a chat without one.
create function public.wa_apply_statuses(p_org uuid, p_statuses jsonb)
returns table (applied integer, stale integer, unknown integer, unknown_ids text[],
               bsuid_filled integer, bsuid_conflicts integer)
language plpgsql
volatile
security invoker
set search_path = ''
set lock_timeout = '3s'
as $$
declare
    v_items jsonb;
    v_total integer;
    v_applied integer;
    v_unknown_ids text[];
    v_pair record;
    v_rows integer;
    v_filled integer := 0;
    v_conflicts integer := 0;
begin
    if p_org is null or p_statuses is null then
        raise exception 'wa_apply_statuses: p_org and p_statuses must not be null' using errcode = '22004';
    end if;
    if jsonb_typeof(p_statuses) <> 'array' then
        raise exception 'wa_apply_statuses: p_statuses must be a JSON array' using errcode = '22023';
    end if;
    v_items := jsonb_path_query_array(p_statuses, '$[*] ? (@.type() == "object")');

    with tracked as (
        select s.id, s.status, s.ts, s.error_code, s.error_title, s.error_detail,
               case s.status when 'read' then 4 when 'delivered' then 3 when 'failed' then 2 else 1 end
                   as status_rank
          from jsonb_to_recordset(v_items) as s(id text, status text, ts timestamptz,
                                                 error_code integer, error_title text, error_detail text)
         where s.id <> '' and s.status in ('sent', 'delivered', 'read', 'failed')
    ),
    collapsed as (
        select distinct on (t.id) t.id, t.status, t.ts, t.error_code, t.error_title, t.error_detail
          from tracked t
         order by t.id, t.status_rank desc, t.ts desc nulls last
    ),
    changed as (
        update public.whatsapp_messages m
           set status = s.status,
               status_updated_at = coalesce(least(s.ts, now()), now()),
               error_code = case when s.status = 'failed' then s.error_code
                                 when m.status = 'failed' then null
                                 else m.error_code end,
               error_title = case when s.status = 'failed' then s.error_title
                                  when m.status = 'failed' then null
                                  else m.error_title end,
               error_detail = case when s.status = 'failed' then s.error_detail
                                   when m.status = 'failed' then null
                                   else m.error_detail end
          from collapsed s
         where m.org_id = p_org
           and m.wa_message_id = s.id
           and m.role = 'assistant'
           and (   m.status is null
                or (s.status = 'delivered' and m.status = 'sent')
                or (s.status = 'read' and m.status in ('sent', 'delivered'))
                or (s.status = 'failed' and m.status = 'sent')
                or (s.status in ('delivered', 'read') and m.status = 'failed'
                    and s.ts > coalesce(m.status_updated_at, '-infinity')))
        returning m.id
    )
    select (select count(*) from collapsed)::integer,
           (select count(*) from changed)::integer,
           coalesce((select array_agg(k.id order by k.id)
                       from collapsed k
                      where not exists (select 1 from public.whatsapp_messages a
                                         where a.org_id = p_org and a.wa_message_id = k.id
                                           and a.role = 'assistant')),
                    '{}')
      into v_total, v_applied, v_unknown_ids;

    -- BSUID backfill per recipient: only on a chat without one, and only while
    -- no chat of the org holds that BSUID. Each in its own savepoint, so a
    -- concurrent writer's BSUID costs this pair only.
    for v_pair in
        select distinct s.recipient_id, s.recipient_user_id
          from jsonb_to_recordset(v_items) as s(id text, status text, recipient_id text, recipient_user_id text)
         where s.id <> '' and s.status in ('sent', 'delivered', 'read', 'failed')
           and s.recipient_id <> '' and s.recipient_user_id <> ''
    loop
        begin
            update public.whatsapp_chats c
               set bsuid = v_pair.recipient_user_id
             where c.org_id = p_org
               and c.phone_number = v_pair.recipient_id
               and c.bsuid is null
               and not exists (select 1 from public.whatsapp_chats o
                                where o.org_id = p_org and o.bsuid = v_pair.recipient_user_id);
            get diagnostics v_rows = row_count;
            v_filled := v_filled + v_rows;
        exception when unique_violation then
            v_conflicts := v_conflicts + 1;
        end;
    end loop;

    applied := v_applied;
    unknown_ids := v_unknown_ids;
    unknown := cardinality(v_unknown_ids);
    stale := v_total - v_applied - cardinality(v_unknown_ids);
    bsuid_filled := v_filled;
    bsuid_conflicts := v_conflicts;
    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Work claim and cleanup (callers from PR-C3)
-- ---------------------------------------------------------------------------

-- Returns, first, the rows with no attempt left that nobody works on (a
-- running row whose lease ran out on its last attempt, or a pending row a
-- worker rescheduled after it), now failed, at most p_limit (the caller tells
-- the operators), then the due rows it claimed,
-- oldest due first: pending rows whose next attempt is due and running rows
-- whose lease ran out, with attempts left; each claim counts one attempt and
-- leases the row for p_lease_seconds. Rows locked by another claimer are
-- skipped, so two claimers never get the same row. p_id: only that row (a
-- kick right after the message was stored), else any row.
create function public.claim_inbound_work(p_limit integer, p_lease_seconds integer, p_id uuid)
returns setof public.whatsapp_inbound_work
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
    if p_limit is null or p_limit < 1 then
        raise exception 'claim_inbound_work: p_limit must be at least 1' using errcode = '22023';
    end if;
    if p_lease_seconds is null or p_lease_seconds < 1 then
        raise exception 'claim_inbound_work: p_lease_seconds must be at least 1' using errcode = '22023';
    end if;

    return query
    update public.whatsapp_inbound_work w
       set state = 'failed',
           lease_until = null
     where w.id in (
           select x.id
             from public.whatsapp_inbound_work x
            where (   x.state = 'pending'
                   or (x.state = 'running' and (x.lease_until is null or x.lease_until < now())))
              and x.attempts >= x.max_attempts
              and (p_id is null or x.id = p_id)
            order by x.next_attempt_at, x.id
            limit p_limit
              for update skip locked)
    returning w.*;

    return query
    update public.whatsapp_inbound_work w
       set state = 'running',
           attempts = w.attempts + 1,
           lease_until = now() + make_interval(secs => p_lease_seconds)
     where w.id in (
           select x.id
             from public.whatsapp_inbound_work x
            where (   (x.state = 'pending' and x.next_attempt_at <= now())
                   or (x.state = 'running' and (x.lease_until is null or x.lease_until < now())))
              and x.attempts < x.max_attempts
              and (p_id is null or x.id = p_id)
            order by x.next_attempt_at, x.id
            limit p_limit
              for update skip locked)
    returning w.*;
end;
$$;

-- Finished work is kept 7 days for review, hourly with the other cleanups.
create function public.cleanup_old_inbound_work()
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
    delete from public.whatsapp_inbound_work w
     where w.state in ('done', 'failed')
       and w.updated_at < now() - interval '7 days';
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants: the service role only
-- ---------------------------------------------------------------------------

revoke execute on function public.wa_ingest_inbound(uuid, text, text, text, timestamptz, text, text, text, text,
    text, text, text, jsonb, boolean, text, integer, boolean, text, integer, text, jsonb)
    from public, anon, authenticated;
revoke execute on function public.wa_apply_statuses(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.claim_inbound_work(integer, integer, uuid) from public, anon, authenticated;
revoke execute on function public.cleanup_old_inbound_work() from public, anon, authenticated;
grant execute on function public.wa_ingest_inbound(uuid, text, text, text, timestamptz, text, text, text, text,
    text, text, text, jsonb, boolean, text, integer, boolean, text, integer, text, jsonb) to service_role;
grant execute on function public.wa_apply_statuses(uuid, jsonb) to service_role;
grant execute on function public.claim_inbound_work(integer, integer, uuid) to service_role;
grant execute on function public.cleanup_old_inbound_work() to service_role;
