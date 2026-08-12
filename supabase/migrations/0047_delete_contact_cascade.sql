-- Atomically delete a contact and everything tied to it: its chat history (the
-- AI's "memory"), pending queue items, and rate-limit rows, then the contact row
-- itself. Deleting whatsapp_chats CASCADEs its proposals and SET NULLs any linked
-- vendor (FKs, migration inspection). Runs as ONE transaction (a function body),
-- so it's all-or-nothing — no half-deleted contact.
--
-- REFUSES when the contact has bookings (orders reference whatsapp_chats with
-- ON DELETE NO ACTION): financial records must never be silently wiped. The
-- caller turns that into a clear "resolve the booking first" message.

create or replace function public.delete_contact_cascade(p_org uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_orders int;
    v_exists boolean;
begin
    -- SECURITY DEFINER bypasses RLS, so gate authorization explicitly: only a
    -- member of this org may delete its contacts. auth.uid() still resolves to the
    -- calling user inside the definer context (PostgREST passes the JWT through).
    if not private.is_org_member(p_org) then
        raise exception 'not authorized to delete contacts for this org'
            using errcode = '42501';
    end if;

    select exists (
        select 1 from public.whatsapp_chats
        where org_id = p_org and phone_number = p_phone
    ) into v_exists;
    if not v_exists then
        return jsonb_build_object('deleted', false, 'reason', 'not_found');
    end if;

    -- Guard financial data: any booking blocks the delete.
    select count(*) into v_orders
    from public.orders
    where org_id = p_org and customer_phone = p_phone;
    if v_orders > 0 then
        return jsonb_build_object('deleted', false, 'reason', 'has_bookings', 'orders', v_orders);
    end if;

    delete from public.whatsapp_messages where org_id = p_org and phone_number = p_phone;
    delete from public.message_queue    where org_id = p_org and phone_number = p_phone;
    delete from public.rate_limits       where identifier = p_org::text || ':' || p_phone;
    delete from public.whatsapp_chats    where org_id = p_org and phone_number = p_phone;

    return jsonb_build_object('deleted', true);
end;
$$;

-- Callable only by signed-in dashboard users (never anon); the body re-checks org
-- membership so the grant can't be abused to touch another org's data. Supabase's
-- default privileges auto-grant EXECUTE to anon/authenticated/service_role on new
-- public functions, so revoke from anon + public EXPLICITLY (revoking from public
-- alone leaves the role-specific anon grant in place).
revoke all on function public.delete_contact_cascade(uuid, text) from public, anon;
grant execute on function public.delete_contact_cascade(uuid, text) to authenticated;
