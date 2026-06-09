-- Fase 1b — on signup, auto-create an org and make the new user its owner.
-- (1 user = 1 org.) org_name comes from signUp options.data.org_name
-- (NEW.raw_user_meta_data->>'org_name').
--
-- Hardening (Supabase managing-user-data guide): security definer so it can
-- write to public tables, set search_path = '' + fully schema-qualified to
-- block search-path hijacking. The function MUST NOT raise — a trigger error
-- rolls back the whole signup ("Database error saving new user"). coalesce
-- guarantees a non-null org name; the org is brand-new so no PK collision.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_org_id uuid;
begin
    insert into public.organizations (name)
    values (coalesce(nullif(new.raw_user_meta_data ->> 'org_name', ''), 'EO Saya'))
    returning id into new_org_id;

    insert into public.organization_members (org_id, user_id, role)
    values (new_org_id, new.id, 'owner');

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();
