-- Tests for claim_queue_jobs (migration 0042): debounced, per-conversation,
-- stale-reclaiming queue claim.
--
-- HOW TO RUN — against a CLEAN / disposable database. The function scans the
-- whole message_queue table, so live traffic would make the p_limit ordering
-- non-deterministic. Use a fresh local stack or a Supabase preview branch:
--     supabase db reset
--     psql "$DATABASE_URL" -f supabase/tests/claim_queue_jobs.test.sql
-- Every scenario runs inside BEGIN ... ROLLBACK, so nothing is ever committed.
--
-- NOT covered here (a single SQL script can't orchestrate two concurrent DB
-- sessions): the "two drainers never double-claim the same row" property. That
-- is guaranteed by the outer UPDATE re-checking status='pending' under a row
-- lock (READ COMMITTED EvalPlanQual); it is validated by reasoning + the
-- app-layer Vitest suite, and noted as a manual check in CONTRIBUTING.

\set ON_ERROR_STOP on

-- ===== Scenario 1 + 2: claim a SETTLED burst in full, HOLD an unsettled one ==
begin;
do $$
declare v_org uuid; v_n int;
begin
  select id into v_org from public.organizations limit 1;
  if v_org is null then raise exception 'need at least one organization row to test'; end if;

  -- Phone A: settled burst (newest message is 2 min old, > 60s debounce).
  insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (v_org, 'TESTQ_A', 'a1', 'pending', now() - interval '120 seconds', now() - interval '120 seconds'),
    (v_org, 'TESTQ_A', 'a2', 'pending', now() - interval '118 seconds', now() - interval '118 seconds'),
    (v_org, 'TESTQ_A', 'a3', 'pending', now() - interval '116 seconds', now() - interval '116 seconds');

  -- Phone B: unsettled burst (just arrived).
  insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (v_org, 'TESTQ_B', 'b1', 'pending', now(), now()),
    (v_org, 'TESTQ_B', 'b2', 'pending', now(), now());

  perform public.claim_queue_jobs(p_limit => 1000, p_stale_seconds => 600, p_debounce_seconds => 60);

  select count(*) into v_n from public.message_queue where phone_number='TESTQ_A' and status='processing';
  assert v_n = 3, format('settled burst A: expected 3 claimed, got %s', v_n);

  select count(*) into v_n from public.message_queue where phone_number='TESTQ_B' and status='pending';
  assert v_n = 2, format('unsettled burst B: expected 2 still pending, got %s', v_n);

  raise notice 'OK 1+2: settled burst claimed in full; unsettled burst held';
end $$;
rollback;

-- ===== Scenario 3: a fresh message RESETS the debounce for the whole convo ===
begin;
do $$
declare v_org uuid; v_n int;
begin
  select id into v_org from public.organizations limit 1;
  insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (v_org, 'TESTQ_C', 'c1', 'pending', now() - interval '120 seconds', now() - interval '120 seconds'),
    (v_org, 'TESTQ_C', 'c2', 'pending', now(), now());  -- brand new -> not settled

  perform public.claim_queue_jobs(p_limit => 1000, p_stale_seconds => 600, p_debounce_seconds => 60);

  select count(*) into v_n from public.message_queue where phone_number='TESTQ_C' and status='pending';
  assert v_n = 2, format('debounce reset: expected 2 still pending, got %s', v_n);
  raise notice 'OK 3: a fresh message holds the whole conversation';
end $$;
rollback;

-- ===== Scenario 4: p_limit bounds CONVERSATIONS, oldest-first ===============
begin;
do $$
declare v_org uuid; v_proc int; v_pending int;
begin
  select id into v_org from public.organizations limit 1;
  -- Three settled conversations; D oldest, F newest.
  insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (v_org, 'TESTQ_D', 'd1', 'pending', now() - interval '300 seconds', now() - interval '300 seconds'),
    (v_org, 'TESTQ_G', 'g1', 'pending', now() - interval '200 seconds', now() - interval '200 seconds'),
    (v_org, 'TESTQ_F', 'f1', 'pending', now() - interval '100 seconds', now() - interval '100 seconds');

  -- Claim only TWO conversations. Must be the two oldest (D, G); F waits.
  -- (Run on a clean DB so no other settled conversation competes for a slot.)
  perform public.claim_queue_jobs(p_limit => 2, p_stale_seconds => 600, p_debounce_seconds => 60);

  select count(*) into v_proc from public.message_queue
   where phone_number in ('TESTQ_D','TESTQ_G') and status='processing';
  assert v_proc = 2, format('p_limit: expected D+G claimed, got %s', v_proc);

  select count(*) into v_pending from public.message_queue
   where phone_number='TESTQ_F' and status='pending';
  assert v_pending = 1, format('p_limit: expected F to wait, got %s pending', v_pending);
  raise notice 'OK 4: p_limit bounds conversations, oldest-first';
end $$;
rollback;

-- ===== Scenario 5: a stranded 'processing' job is reclaimed ==================
begin;
do $$
declare v_org uuid; v_status text; v_retries int;
begin
  select id into v_org from public.organizations limit 1;
  -- A job stuck in 'processing' by a crashed worker (last touched 11 min ago).
  insert into public.message_queue (org_id, phone_number, message_text, status, retries, created_at, updated_at) values
    (v_org, 'TESTQ_E', 'e1', 'processing', 0, now() - interval '20 minutes', now() - interval '11 minutes');

  perform public.claim_queue_jobs(p_limit => 1000, p_stale_seconds => 600, p_debounce_seconds => 60);

  select status, retries into v_status, v_retries from public.message_queue where phone_number='TESTQ_E';
  -- Step 1 re-pends it (retries 0->1); step 2 then re-claims it (it is settled).
  assert v_retries = 1, format('stale reclaim: expected retries=1, got %s', v_retries);
  assert v_status = 'processing', format('stale reclaim: expected processing, got %s', v_status);
  raise notice 'OK 5: stranded processing job reclaimed (retries bumped) and re-claimed';
end $$;
rollback;
