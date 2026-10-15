-- Max ONE active online meeting per customer (audit KEA-12).
--
-- Purpose: reserve_meeting_slot is driven by the AI schedule_meeting tool, which
-- any WhatsApp sender can trigger by plain conversation (or prompt injection).
-- Until now the only limits were per DAY (conflict + buffer, max N/day), so a
-- single number could book every free slot on any number of future days — each
-- booking creating a Zoom room and pinging the sales team on WhatsApp/email.
-- Owner decision: a customer number may hold at most 1 active meeting per org.
--
-- "Active" meeting (same signal the calendar / Bookings UI use for a meeting):
--   org_id = p_org, order_type = 'service', meeting_link is not null,
--   customer_phone = p_phone, status NOT IN ('cancelled', 'completed'),
--   and the meeting has not ENDED yet (event_date + duration > now(); rows
--   without a stored duration fall back to 60 min, like the conflict check).
-- Meetings are cancelled by DELETING the row (Bookings "Batalkan"), and marked
-- done with status 'completed' — both free the customer to book again.
--
-- Behaviour kept IDENTICAL to 0057 (same signature, same return keys, same
-- order of checks), with one rule inserted after the idempotency check:
--   1) idempotency: same customer + exact same slot → return that meeting
--   2) NEW customer limit: another active meeting for (org, phone) → return
--        { meeting_id: null, created: false, full: false, conflict: false,
--          customer_limit: true,
--          existing_meeting_id: <uuid>, existing_event_date: <timestamptz> }
--      meeting_id stays NULL on purpose: app code deployed before this
--      migration treats a NULL meeting_id as "not booked", never as an
--      idempotent hit on the other meeting.
--   3) conflict (+ buffer), 4) daily cap, 5) insert — unchanged.
-- Every other result now also carries "customer_limit": false.
--
-- Concurrency: the customer rule spans days, so the per-(org, day) advisory lock
-- alone can't serialize two bookings by the same number on different days. A
-- second transaction-scoped lock keyed on (org, phone) is taken FIRST, then the
-- (org, day) lock — always in that order, so concurrent calls can't deadlock.
--
-- Privileges: least privilege — only service_role (the webhook/queue path via
-- createServiceOrServerClient) may execute; revoked from public, anon and
-- authenticated (also covers audit KEA-5 for this function).
--
-- Reversibility: re-run 0057_reserve_meeting_conflict.sql's CREATE body (as a
-- CREATE OR REPLACE) to restore the previous behaviour; note 0057 also grants
-- EXECUTE to authenticated. No table/data changes in this migration.
-- Re-runnable: CREATE OR REPLACE + idempotent REVOKE/GRANT.
-- Transaction: no explicit begin/commit, like 0054-0057 — the migration runner
-- (Supabase CLI / MCP apply_migration) wraps the file in its own transaction,
-- and an inner COMMIT would end that transaction early.

create or replace function public.reserve_meeting_slot(
    p_org           uuid,
    p_phone         text,
    p_name          text,
    p_event_date    timestamptz,
    p_delivery_info text,
    p_day_start     timestamptz,
    p_day_end       timestamptz,
    p_max           int,
    p_duration_min  int,
    p_buffer_min    int
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_count         int;
    v_id            uuid;
    v_existing      uuid;
    v_active_id     uuid;
    v_active_date   timestamptz;
begin
    -- Serialize reservations for the same org + customer (the one-active-meeting
    -- rule spans days), then for the same org + WIB day (idempotency, conflict,
    -- count and insert). Lock order is fixed: customer first, then day. Both are
    -- released at transaction end.
    perform pg_advisory_xact_lock(hashtext(p_org::text), hashtext('customer:' || coalesce(p_phone, '')));
    perform pg_advisory_xact_lock(hashtext(p_org::text), hashtext(p_day_start::text));

    -- 1) Idempotency: same customer already booked at this exact time → return it
    --    (must come first, so a genuine repeat isn't blocked by the rules below).
    select id into v_existing
    from public.orders
    where org_id = p_org
      and order_type = 'service'
      and meeting_link is not null
      and customer_phone = p_phone
      and event_date = p_event_date
    limit 1;

    if v_existing is not null then
        return jsonb_build_object('meeting_id', v_existing, 'created', false, 'full', false, 'conflict', false, 'customer_limit', false);
    end if;

    -- 2) Customer limit: max 1 active (not cancelled/completed, not yet ended)
    --    meeting per (org, customer_phone). Report the existing one so the
    --    caller can tell the customer when it is.
    select o.id, o.event_date into v_active_id, v_active_date
    from public.orders o
    where o.org_id = p_org
      and o.order_type = 'service'
      and o.meeting_link is not null
      and o.customer_phone = p_phone
      and coalesce(o.status, '') not in ('cancelled', 'completed')
      and o.event_date + (coalesce(o.meeting_duration_min, 60) || ' minutes')::interval > now()
    order by o.event_date
    limit 1;

    if v_active_id is not null then
        return jsonb_build_object(
            'meeting_id', null, 'created', false, 'full', false, 'conflict', false,
            'customer_limit', true,
            'existing_meeting_id', v_active_id,
            'existing_event_date', v_active_date
        );
    end if;

    -- 3) Conflict: the requested slot, padded by the buffer on both sides, must
    --    not overlap any existing meeting that day (older rows without a stored
    --    duration fall back to 60 min, matching the calendar).
    if exists (
        select 1
        from public.orders o
        where o.org_id = p_org
          and o.order_type = 'service'
          and o.meeting_link is not null
          and o.event_date >= p_day_start
          and o.event_date <  p_day_end
          and tstzrange(
                  o.event_date,
                  o.event_date + (coalesce(o.meeting_duration_min, 60) || ' minutes')::interval
              ) && tstzrange(
                  p_event_date - (p_buffer_min || ' minutes')::interval,
                  p_event_date + ((p_duration_min + p_buffer_min) || ' minutes')::interval
              )
    ) then
        return jsonb_build_object('meeting_id', null, 'created', false, 'full', false, 'conflict', true, 'customer_limit', false);
    end if;

    -- 4) Daily cap.
    select count(*) into v_count
    from public.orders
    where org_id = p_org
      and order_type = 'service'
      and meeting_link is not null
      and event_date >= p_day_start
      and event_date <  p_day_end;

    if v_count >= p_max then
        return jsonb_build_object('meeting_id', null, 'created', false, 'full', true, 'conflict', false, 'customer_limit', false);
    end if;

    -- 5) Reserve. Store the duration now so a concurrent conflict check sees the
    --    correct length immediately (not after the caller's follow-up update).
    insert into public.orders (
        org_id, customer_phone, customer_name, items, total_amount,
        status, order_type, event_date, meeting_link, delivery_info, meeting_duration_min
    ) values (
        p_org, p_phone, p_name, '[]'::jsonb, 0,
        'scheduled', 'service', p_event_date, 'pending-link', p_delivery_info, p_duration_min
    ) returning id into v_id;

    return jsonb_build_object('meeting_id', v_id, 'created', true, 'full', false, 'conflict', false, 'customer_limit', false);
end;
$$;

-- Least privilege: only the service role (webhook / queue path) may reserve.
revoke execute on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int, int, int) from public, anon, authenticated;
grant execute on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int, int, int) to service_role;
