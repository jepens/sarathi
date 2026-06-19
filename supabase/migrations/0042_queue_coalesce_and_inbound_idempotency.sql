-- Fix "double chat": coalesce burst messages + dedupe duplicate webhook
-- deliveries.
--
-- Two distinct causes of the bot replying twice:
--   V1 (primary) — a human sends several short WhatsApp messages in a row, and
--       each one was enqueued + answered independently → one AI reply per
--       fragment. Fix: claim PER CONVERSATION, and only once the burst has
--       settled (no new message within a debounce window). processQueue then
--       coalesces a conversation's queued messages into a single AI turn.
--   V2 (latent) — Meta delivers webhooks at-least-once, so the SAME inbound
--       message can arrive twice → two queue rows → two identical replies. Fix:
--       record the inbound message id (wamid) and enforce uniqueness, so a
--       redelivery can't enqueue (or store) the same message again.
--
-- (The send-then-resend race, V3, is fixed in application code: the job is
--  marked completed immediately after a successful send, before history writes.)

-- ========== V2: inbound idempotency on message id (wamid) ==========

-- message_queue: remember which inbound message produced the job, and make a
-- redelivery a no-op (insert hits the unique index → app treats it as a dup).
alter table public.message_queue
    add column if not exists wa_message_id text;

create unique index if not exists uniq_message_queue_org_wamid
    on public.message_queue(org_id, wa_message_id)
    where wa_message_id is not null;

-- whatsapp_messages: dedupe the stored conversation too, so a redelivered
-- inbound message isn't written into history twice.
-- Collapse any pre-existing duplicate wamids first (keep the earliest row) so
-- the unique index can be created without failing on legacy data. Scope BOTH
-- the de-dup and the index by role: an inbound (user) wamid and any
-- outbound/echo row that happened to share a wamid are semantically distinct
-- rows and must not be collapsed into one (uniqueness is per role).
delete from public.whatsapp_messages a
    using public.whatsapp_messages b
 where a.wa_message_id is not null
   and a.org_id = b.org_id
   and a.wa_message_id = b.wa_message_id
   and a.role = b.role
   and a.ctid > b.ctid;

create unique index if not exists uniq_whatsapp_messages_org_wamid
    on public.whatsapp_messages(org_id, wa_message_id, role)
    where wa_message_id is not null;

-- ========== V1: per-conversation, debounced claim ==========

-- Replace the per-row claimer with a per-conversation one. Signature changes
-- (adds p_debounce_seconds), so drop the old 2-arg version explicitly.
drop function if exists public.claim_queue_jobs(int, int);

create or replace function public.claim_queue_jobs(
    p_limit int default 10,
    p_stale_seconds int default 180,
    p_debounce_seconds int default 60
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

    -- 2. Claim ALL pending rows for conversations whose burst has SETTLED — i.e.
    --    no new message arrived within the debounce window (the newest pending
    --    message is older than p_debounce_seconds). Returning every pending row
    --    for the conversation lets the worker coalesce them into one AI reply.
    --
    --    Concurrency: two drainers (inline webhook + per-minute cron) may pick
    --    the same conversation in the sub-select, but the UPDATE re-checks
    --    status = 'pending' under a row lock (READ COMMITTED EvalPlanQual), so
    --    only the first drainer actually flips the rows; the second updates zero
    --    rows for that conversation. No double reply, no stranded rows.
    return query
    update public.message_queue q
       set status = 'processing',
           updated_at = now()
     where q.status = 'pending'
       and (q.org_id, q.phone_number) in (
           select c.org_id, c.phone_number
             from public.message_queue c
            where c.status = 'pending'
            group by c.org_id, c.phone_number
           having max(c.created_at) < now() - make_interval(secs => p_debounce_seconds)
            order by min(c.created_at)
            limit p_limit
       )
    returning q.*;
end;
$function$;

-- Only the service-role queue worker calls this (mirrors 0041).
revoke execute on function public.claim_queue_jobs(int, int, int) from anon, authenticated, public;
grant execute on function public.claim_queue_jobs(int, int, int) to service_role;
