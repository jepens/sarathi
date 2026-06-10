-- Queue hardening: atomic claim + stale-job reclaim.
--
-- Why: the queue is drained inline by the webhook (fire-and-forget) AND, now,
-- by a per-minute cron (Easypanel scheduled task). Two problems the old
-- select-then-update flow had — both made worse by adding a second trigger:
--   1. Double-reply race: two drainers could SELECT the same 'pending' row
--      before either marked it 'processing', sending the customer two replies.
--   2. Stranded jobs: a worker that crashed/restarted between 'processing' and
--      'completed' left the row stuck at 'processing' forever — the drainer only
--      ever looks at 'pending', so that message was never answered or retried.
--
-- Fix: a single SECURITY DEFINER function that (a) reclaims stale 'processing'
-- rows back to 'pending' (or 'failed' once retries are exhausted), then
-- (b) claims pending rows atomically with FOR UPDATE SKIP LOCKED — the standard
-- Postgres work-queue pattern. Concurrent drainers each get a disjoint batch.
--
-- Only the service-role queue worker calls this; revoke from anon/authenticated
-- /public so it is not exposed as a PostgREST RPC (mirrors 0037).

create or replace function public.claim_queue_jobs(
    p_limit int default 10,
    p_stale_seconds int default 180
)
returns setof public.message_queue
language plpgsql
security definer
set search_path to ''
as $function$
begin
    -- 1. Reclaim jobs stranded in 'processing' (worker died mid-job). Bump
    --    retries so a job that reliably crashes the worker eventually fails
    --    instead of looping forever.
    update public.message_queue
       set status = case when retries + 1 >= max_retries then 'failed' else 'pending' end,
           retries = retries + 1,
           error_message = 'Reclaimed from stale processing',
           processed_at = case when retries + 1 >= max_retries then now() else processed_at end,
           updated_at = now()
     where status = 'processing'
       and updated_at < now() - make_interval(secs => p_stale_seconds);

    -- 2. Atomically claim a batch of pending jobs. SKIP LOCKED lets concurrent
    --    drainers (inline webhook + cron) take disjoint rows without blocking.
    return query
    update public.message_queue q
       set status = 'processing',
           updated_at = now()
     where q.id in (
         select id
           from public.message_queue
          where status = 'pending'
          order by created_at
          for update skip locked
          limit p_limit
     )
    returning q.*;
end;
$function$;

revoke execute on function public.claim_queue_jobs(int, int) from anon, authenticated, public;
grant execute on function public.claim_queue_jobs(int, int) to service_role;
