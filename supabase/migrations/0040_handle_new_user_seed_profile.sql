-- Fase B: when a new EO signs up, seed a starter business profile from their org
-- name so their bot immediately speaks as themselves (generic 'Asisten') rather
-- than falling back to anything Sailendra-flavoured. Extends the existing signup
-- trigger; existing orgs are unaffected (Sailendra already has its row from 0039).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
    new_org_id uuid;
    v_org_name text;
begin
    v_org_name := coalesce(nullif(new.raw_user_meta_data ->> 'org_name', ''), 'EO Saya');

    insert into public.organizations (name)
    values (v_org_name)
    returning id into new_org_id;

    insert into public.organization_members (org_id, user_id, role)
    values (new_org_id, new.id, 'owner');

    -- Starter profile: business_name = the org name, assistant_name = generic.
    -- The owner refines the rest in Settings -> Profil Bisnis.
    insert into public.business_profiles (org_id, business_name, assistant_name)
    values (new_org_id, v_org_name, 'Asisten')
    on conflict (org_id) do nothing;

    return new;
end;
$function$;
