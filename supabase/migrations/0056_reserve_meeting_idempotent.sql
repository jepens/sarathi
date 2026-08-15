-- Make reserve_meeting_slot idempotent so a repeated schedule_meeting call for
-- the SAME customer at the SAME time doesn't create a duplicate booking (and a
-- duplicate Zoom room + email). The model can call the tool twice — a retry, or
-- re-confirming the same slot — and there is no idempotency key in the args.
--
-- The return type changes (uuid -> jsonb) to carry three outcomes, so the old
-- function is dropped and recreated. Callers must read the JSON:
--   { "meeting_id": <uuid|null>, "created": <bool>, "full": <bool> }
--   * created=true            -> a fresh row was inserted
--   * created=false, full=false -> an existing booking for this exact slot was returned
--   * full=true               -> the day is at the cap; nothing inserted

drop function if exists public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int);

create function public.reserve_meeting_slot(
    p_org           uuid,
    p_phone         text,
    p_name          text,
    p_event_date    timestamptz,
    p_delivery_info text,
    p_day_start     timestamptz,
    p_day_end       timestamptz,
    p_max           int
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
    -- Serialize reservations for the same org + WIB day (lock auto-released at
    -- transaction end) so the idempotency check, count, and insert are atomic.
    perform pg_advisory_xact_lock(hashtext(p_org::text), hashtext(p_day_start::text));

    -- Idempotency: same customer already booked at this exact time → return it.
    select id into v_existing
    from public.orders
    where org_id = p_org
      and order_type = 'service'
      and meeting_link is not null
      and customer_phone = p_phone
      and event_date = p_event_date
    limit 1;

    if v_existing is not null then
        return jsonb_build_object('meeting_id', v_existing, 'created', false, 'full', false);
    end if;

    select count(*) into v_count
    from public.orders
    where org_id = p_org
      and order_type = 'service'
      and meeting_link is not null
      and event_date >= p_day_start
      and event_date <  p_day_end;

    if v_count >= p_max then
        return jsonb_build_object('meeting_id', null, 'created', false, 'full', true);
    end if;

    insert into public.orders (
        org_id, customer_phone, customer_name, items, total_amount,
        status, order_type, event_date, meeting_link, delivery_info
    ) values (
        p_org, p_phone, p_name, '[]'::jsonb, 0,
        'scheduled', 'service', p_event_date, 'pending-link', p_delivery_info
    ) returning id into v_id;

    return jsonb_build_object('meeting_id', v_id, 'created', true, 'full', false);
end;
$$;

-- Least privilege (re-applied — DROP cleared the old grants). Supabase's default
-- privileges grant EXECUTE on new public functions to anon + authenticated, so
-- revoke from BOTH public and anon; only the app roles may call it.
revoke all on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int) from public;
revoke all on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int) from anon;
grant execute on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int) to authenticated, service_role;
