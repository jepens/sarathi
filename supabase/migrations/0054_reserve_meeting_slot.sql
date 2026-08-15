-- Atomic daily-cap reservation for the auto-scheduled online meeting.
--
-- scheduleMeeting() used to count that day's meetings and then insert in two
-- separate round-trips — a TOCTOU race where two concurrent bookings for the
-- same WIB day could both pass the "max 4/day" check and both insert, exceeding
-- the cap. This RPC makes the count + insert atomic: a transaction-scoped
-- advisory lock keyed on (org, day) serializes concurrent reservations for the
-- same day, so the count the insert sees is authoritative.
--
-- It inserts the row with the 'pending-link' placeholder; the caller updates
-- meeting_link with the real Zoom URL afterwards (kept OUT of this function so no
-- external HTTP call ever runs while the advisory lock is held).
--
-- Returns the new order id, or NULL when the day is already full.

create or replace function public.reserve_meeting_slot(
    p_org           uuid,
    p_phone         text,
    p_name          text,
    p_event_date    timestamptz,
    p_delivery_info text,
    p_day_start     timestamptz,
    p_day_end       timestamptz,
    p_max           int
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_count int;
    v_id    uuid;
begin
    -- Serialize reservations for the same org + WIB day (lock auto-released at
    -- transaction end). Two 64-bit keys → two_int form of pg_advisory_xact_lock.
    perform pg_advisory_xact_lock(hashtext(p_org::text), hashtext(p_day_start::text));

    select count(*) into v_count
    from public.orders
    where org_id = p_org
      and order_type = 'service'
      and meeting_link is not null
      and event_date >= p_day_start
      and event_date <  p_day_end;

    if v_count >= p_max then
        return null;
    end if;

    insert into public.orders (
        org_id, customer_phone, customer_name, items, total_amount,
        status, order_type, event_date, meeting_link, delivery_info
    ) values (
        p_org, p_phone, p_name, '[]'::jsonb, 0,
        'scheduled', 'service', p_event_date, 'pending-link', p_delivery_info
    ) returning id into v_id;

    return v_id;
end;
$$;

-- Least privilege: callable only by the roles the app uses (the webhook uses the
-- service role; the dashboard test-chat runs as an authenticated user). Supabase's
-- default privileges grant EXECUTE on new public functions to anon + authenticated
-- directly, so revoke from BOTH public and anon — an unauthenticated caller must
-- never be able to insert an order via /rest/v1/rpc.
revoke all on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int) from public;
revoke all on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int) from anon;
grant execute on function public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, int) to authenticated, service_role;
