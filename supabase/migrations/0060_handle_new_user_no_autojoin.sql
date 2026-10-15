-- Fase 0 — new auth users no longer auto-join the Sailendra (seed) org
-- (audit 2026-10-15: KEA-1; major finding of the PR-A review).
--
-- 0043 attached EVERY new auth.users row to the seed org as 'owner'. With public
-- sign-up now disabled, new users only come from platform provisioning (team-run
-- onboarding for the closed pilot) — and each of those users must belong to THEIR
-- tenant, never to Sailendra. Because getCurrentOrgId() resolves the oldest
-- membership, an auto-added seed membership would also outrank the user's real
-- org and silently put them inside Sailendra's data.
--
-- New behaviour (fail-closed):
--   - A membership is created ONLY when the user is provisioned with an explicit
--     org in raw_app_meta_data (`app_metadata.org_id`, optional
--     `app_metadata.org_role` = owner | admin | staff, default staff). App
--     metadata is server-controlled (admin API / service role); users cannot set
--     it themselves.
--   - Otherwise no membership is created: the user signs in to an empty, org-less
--     state until a platform admin adds an organization_members row.
--   - A malformed org_id is ignored (treated as "no org"); a well-formed but
--     unknown org_id fails the user creation via the FK — loud, for the admin.
--
-- Existing users and memberships are untouched (the trigger only runs on insert).
--
-- Reversibility: re-run the CREATE OR REPLACE from 0043_single_tenant_signup.sql
-- to restore the auto-join behaviour.
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
    v_org_text text := new.raw_app_meta_data ->> 'org_id';
    v_role     public.org_role;
begin
    if v_org_text is null
       or v_org_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return new;
    end if;

    v_role := case new.raw_app_meta_data ->> 'org_role'
                  when 'owner' then 'owner'::public.org_role
                  when 'admin' then 'admin'::public.org_role
                  else 'staff'::public.org_role
              end;

    insert into public.organization_members (org_id, user_id, role)
    values (v_org_text::uuid, new.id, v_role)
    on conflict do nothing;

    return new;
end;
$function$;

-- Trigger function: never callable through the API (same as 0037).
revoke execute on function public.handle_new_user() from public, anon, authenticated;
