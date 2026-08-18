-- Add time-conflict detection (with a buffer) to reserve_meeting_slot.
--
-- Before this, the daily cap (max 4/day) was the only capacity guard — two
-- different customers could book the SAME or overlapping time on the same day,
-- double-booking the sales team. This adds an overlap check: the requested slot,
-- expanded by p_buffer_min on both sides, must not overlap any existing meeting
-- that day. So consecutive meetings need at least p_buffer_min minutes of gap
-- (no more "mepet" back-to-back).
--
-- Interval math uses tstzrange + the && overlap operator (Postgres range docs).
-- tstzrange defaults to '[)' bounds, so truly adjacent ranges don't overlap; the
-- buffer is what enforces the gap. The check runs under the same per-(org,day)
-- advisory lock as the count + insert, so it stays atomic against concurrent
-- bookings.
--
-- Signature changes (adds p_duration_min + p_buffer_min, and now stores the
-- duration on the row at insert time) so the function is dropped + recreated.
-- Return jsonb gains a "conflict" field:
--   { meeting_id uuid|null, created bool, full bool, conflict bool }

drop function if exists public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int);

create function public.reserve_meeting_slot(
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
    v_count    int;
    v_id       uuid;
    v_existing uuid;
begin
    -- Serialize reservations for the same org + WIB day so the idempotency,
    -- conflict, count, and insert are all atomic (lock released at txn end).
    perform pg_advisory_xact_lock(hashtext(p_org::text), hashtext(p_day_start::text));

    -- 1) Idempotency: same customer already booked at this exact time → return it
    --    (must come first, so a genuine repeat isn't blocked by "conflict" below).
    select id into v_existing
    from public.orders
    where org_id = p_org
      and order_type = 'service'
      and meeting_link is not null
      and customer_phone = p_phone
      and event_date = p_event_date
    limit 1;

    if v_existing is not null then
        return jsonb_build_object('meeting_id', v_existing, 'created', false, 'full', false, 'conflict', false);
    end if;

    -- 2) Conflict: the requested slot, padded by the buffer on both sides, must
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
        return jsonb_build_object('meeting_id', null, 'created', false, 'full', false, 'conflict', true);
    end if;

    -- 3) Daily cap.
    select count(*) into v_count
    from public.orders
    where org_id = p_org
      and order_type = 'service'
      and meeting_link is not null
      and event_date >= p_day_start
      and event_date <  p_day_end;

    if v_count >= p_max then
        return jsonb_build_object('meeting_id', null, 'created', false, 'full', true, 'conflict', false);
    end if;

    -- 4) Reserve. Store the duration now so a concurrent conflict check sees the
    --    correct length immediately (not after the caller's follow-up update).
    insert into public.orders (
        org_id, customer_phone, customer_name, items, total_amount,
        status, order_type, event_date, meeting_link, delivery_info, meeting_duration_min
    ) values (
        p_org, p_phone, p_name, '[]'::jsonb, 0,
        'scheduled', 'service', p_event_date, 'pending-link', p_delivery_info, p_duration_min
    ) returning id into v_id;

    return jsonb_build_object('meeting_id', v_id, 'created', true, 'full', false, 'conflict', false);
end;
$$;

-- Least privilege (re-applied — DROP cleared grants). Revoke from public AND anon
-- (Supabase default-grants EXECUTE to anon); only the app roles may call it.
revoke all on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int, int, int) from public;
revoke all on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int, int, int) from anon;
grant execute on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int, int, int) to authenticated, service_role;
