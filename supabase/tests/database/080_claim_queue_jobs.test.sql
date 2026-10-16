-- Tests for claim_queue_jobs (migration 0042): debounced, per-conversation,
-- stale-reclaiming queue claim. pgTAP version of the former psql/ASSERT script
-- (same five scenarios), run by `supabase test db`.
--
-- Everything runs in ONE transaction that is rolled back at the end. now() is
-- frozen for the whole transaction, so every scenario's timestamps are relative
-- to the same instant; rows of a finished scenario are deleted before the next
-- one so p_limit ordering only sees that scenario's conversations.
--
-- NOT covered here (a single SQL session can't orchestrate two concurrent
-- drainers): the "two drainers never double-claim the same row" property. That
-- is guaranteed by the outer UPDATE re-checking status='pending' under a row
-- lock (READ COMMITTED EvalPlanQual) and is validated by reasoning + the
-- app-layer Vitest suite.
begin;
select plan(9);

-- The queue is service-role only; run the claimer the way the worker does.
select tests.authenticate_as_service_role();

-- ===== Scenario 1 + 2: claim a SETTLED burst in full, HOLD an unsettled one ==
-- Phone A: settled burst (newest message is 2 min old, > 60s debounce).
insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (tests.seed_org(), 'TESTQ_A', 'a1', 'pending', now() - interval '120 seconds', now() - interval '120 seconds'),
    (tests.seed_org(), 'TESTQ_A', 'a2', 'pending', now() - interval '118 seconds', now() - interval '118 seconds'),
    (tests.seed_org(), 'TESTQ_A', 'a3', 'pending', now() - interval '116 seconds', now() - interval '116 seconds');
-- Phone B: unsettled burst (just arrived).
insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (tests.seed_org(), 'TESTQ_B', 'b1', 'pending', now(), now()),
    (tests.seed_org(), 'TESTQ_B', 'b2', 'pending', now(), now());

select results_eq(
    $$ select message_text from public.claim_queue_jobs(p_limit => 1000, p_stale_seconds => 600, p_debounce_seconds => 60)
       order by message_text $$,
    array['a1', 'a2', 'a3'],
    'claim returns exactly the settled burst');
select is(
    (select count(*)::int from public.message_queue where phone_number = 'TESTQ_A' and status = 'processing'),
    3, 'settled burst A: all 3 rows claimed');
select is(
    (select count(*)::int from public.message_queue where phone_number = 'TESTQ_B' and status = 'pending'),
    2, 'unsettled burst B: both rows still pending');

delete from public.message_queue where phone_number like 'TESTQ_%';

-- ===== Scenario 3: a fresh message RESETS the debounce for the whole convo ===
insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (tests.seed_org(), 'TESTQ_C', 'c1', 'pending', now() - interval '120 seconds', now() - interval '120 seconds'),
    (tests.seed_org(), 'TESTQ_C', 'c2', 'pending', now(), now());  -- brand new -> not settled

select is_empty(
    $$ select 1 from public.claim_queue_jobs(p_limit => 1000, p_stale_seconds => 600, p_debounce_seconds => 60) $$,
    'debounce reset: nothing is claimed');
select is(
    (select count(*)::int from public.message_queue where phone_number = 'TESTQ_C' and status = 'pending'),
    2, 'debounce reset: a fresh message holds the whole conversation');

delete from public.message_queue where phone_number like 'TESTQ_%';

-- ===== Scenario 4: p_limit bounds CONVERSATIONS, oldest-first ===============
-- Three settled conversations; D oldest, F newest.
insert into public.message_queue (org_id, phone_number, message_text, status, created_at, updated_at) values
    (tests.seed_org(), 'TESTQ_D', 'd1', 'pending', now() - interval '300 seconds', now() - interval '300 seconds'),
    (tests.seed_org(), 'TESTQ_G', 'g1', 'pending', now() - interval '200 seconds', now() - interval '200 seconds'),
    (tests.seed_org(), 'TESTQ_F', 'f1', 'pending', now() - interval '100 seconds', now() - interval '100 seconds');

-- Claim only TWO conversations. Must be the two oldest (D, G); F waits.
select results_eq(
    $$ select phone_number from public.claim_queue_jobs(p_limit => 2, p_stale_seconds => 600, p_debounce_seconds => 60)
       order by phone_number $$,
    array['TESTQ_D', 'TESTQ_G'],
    'p_limit: the two oldest conversations are claimed');
select is(
    (select count(*)::int from public.message_queue where phone_number = 'TESTQ_F' and status = 'pending'),
    1, 'p_limit: the newest conversation waits');

delete from public.message_queue where phone_number like 'TESTQ_%';

-- ===== Scenario 5: a stranded 'processing' job is reclaimed ==================
-- A job stuck in 'processing' by a crashed worker (last touched 11 min ago).
insert into public.message_queue (org_id, phone_number, message_text, status, retries, created_at, updated_at) values
    (tests.seed_org(), 'TESTQ_E', 'e1', 'processing', 0, now() - interval '20 minutes', now() - interval '11 minutes');

select lives_ok(
    $$ select public.claim_queue_jobs(p_limit => 1000, p_stale_seconds => 600, p_debounce_seconds => 60) $$,
    'stale reclaim: claim runs');
-- Step 1 re-pends it (retries 0->1); step 2 then re-claims it (it is settled).
select results_eq(
    $$ select status, retries from public.message_queue where phone_number = 'TESTQ_E' $$,
    $$ values ('processing'::text, 1) $$,
    'stale reclaim: retries bumped and the job is claimed again');

select * from finish();
rollback;
