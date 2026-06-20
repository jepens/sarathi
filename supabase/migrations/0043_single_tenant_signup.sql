-- Single-tenant signup. The app is no longer a multi-tenant SaaS: public
-- self-serve signup is disabled (the /signup page redirects to /login) and
-- there is exactly one organization (the Sailendra seed org from 0026).
--
-- Rewrite handle_new_user so a newly-created auth user is attached to that one
-- seed org as a member, instead of minting a brand-new organization (the old
-- behaviour from 0031/0040). This only fires for admin-provisioned accounts now,
-- but it keeps org_id resolution consistent: every user belongs to the one org,
-- so RLS (is_org_member) and getCurrentOrgId() agree.
--
-- Reversible: restore the prior function body to bring back per-signup orgs.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
    seed_org_id uuid := '5a11e024-0001-4000-8000-000000000001';
begin
    -- Attach the new user to the single existing org. Never create a new org.
    insert into public.organization_members (org_id, user_id, role)
    values (seed_org_id, new.id, 'owner')
    on conflict do nothing;

    return new;
end;
$function$;
