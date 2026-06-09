-- Harden is_org_member: move the SECURITY DEFINER helper into a private schema
-- so it is NOT exposed via PostgREST RPC (security advisor 0029), while RLS
-- policies keep referencing it by qualified name. Pattern per Supabase RLS guide
-- (`private.has_good_role()`).

create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_org_member(check_org uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
    select exists (
        select 1
        from public.organization_members m
        where m.org_id = check_org
          and m.user_id = (select auth.uid())
    );
$$;
revoke all on function private.is_org_member(uuid) from public, anon;
grant execute on function private.is_org_member(uuid) to authenticated;

-- Repoint tenant-table policies to the private helper.
do $$
declare t text;
begin
    foreach t in array array[
        'whatsapp_chats', 'whatsapp_messages', 'documents', 'kb_sources',
        'products', 'orders', 'proposals', 'vendors', 'system_message',
        'app_settings'
    ]
    loop
        execute format('drop policy if exists "org members full access" on public.%I', t);
        execute format(
            'create policy "org members full access" on public.%I for all to authenticated using (private.is_org_member(org_id)) with check (private.is_org_member(org_id))',
            t
        );
    end loop;
end $$;

-- Repoint the organizations policy too.
drop policy if exists "members read their org" on public.organizations;
create policy "members read their org" on public.organizations
    for select to authenticated using (private.is_org_member(id));

-- Remove the API-exposed public helper now that nothing references it.
drop function if exists public.is_org_member(uuid);
