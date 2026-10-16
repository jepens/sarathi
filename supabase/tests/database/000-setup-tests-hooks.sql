-- Test hooks for `supabase test db` (tracker 1.2 / 1.14, audit KUA-13).
--
-- Runs first (files run in alphabetical order) and installs the shared test
-- helpers in a dedicated `tests` schema, following Supabase's "Advanced pgTAP
-- testing" guide (000-setup-tests-hooks.sql + helpers in the spirit of
-- basejump's supabase_test_helpers). The helpers are written here instead of
-- being fetched from database.dev so the suite has no network dependency.
--
-- This file COMMITS (it is the only one that does): the `tests` schema stays in
-- the LOCAL database after a run. It is recreated from scratch on every run and
-- is never part of supabase/migrations, so it never reaches production. Every
-- *.test.sql file runs inside BEGIN ... ROLLBACK and leaves no data behind.
--
-- Acting as a user follows Supabase's RLS testing docs: switch to the
-- `authenticated` (or `anon`) role and set the JWT claims that auth.uid()
-- reads (request.jwt.claims / request.jwt.claim.sub), transaction-local.

drop schema if exists tests cascade;
create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixed fixture ids: two tenant orgs (A, B) and three users.
--   a1 = owner of org A, a2 = staff of org A (same org, different user),
--   b1 = owner of org B. The seed org (Sailendra) from 0026 also exists.
-- ---------------------------------------------------------------------------
create function tests.seed_org() returns uuid language sql immutable
    as $$ select '5a11e024-0001-4000-8000-000000000001'::uuid $$;
create function tests.org_a() returns uuid language sql immutable
    as $$ select 'aaaaaaaa-0000-4000-8000-00000000000a'::uuid $$;
create function tests.org_b() returns uuid language sql immutable
    as $$ select 'bbbbbbbb-0000-4000-8000-00000000000b'::uuid $$;
create function tests.user_a1() returns uuid language sql immutable
    as $$ select 'aaaaaaaa-1111-4000-8000-0000000000a1'::uuid $$;
create function tests.user_a2() returns uuid language sql immutable
    as $$ select 'aaaaaaaa-2222-4000-8000-0000000000a2'::uuid $$;
create function tests.user_b1() returns uuid language sql immutable
    as $$ select 'bbbbbbbb-1111-4000-8000-0000000000b1'::uuid $$;

-- ---------------------------------------------------------------------------
-- Users and orgs (call as postgres, before switching roles)
-- ---------------------------------------------------------------------------

-- Creates an auth.users row the way GoTrue would for an admin-provisioned
-- user. p_app_metadata is what the platform sets (org_id / org_role); the
-- handle_new_user trigger (0060) turns it into an organization_members row.
create function tests.create_supabase_user(
    p_id uuid,
    p_email text,
    p_app_metadata jsonb default '{}'::jsonb
) returns uuid
language sql
as $$
    insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        raw_app_meta_data, raw_user_meta_data,
        email_confirmed_at, created_at, updated_at
    ) values (
        p_id, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', p_email, '',
        '{"provider": "email", "providers": ["email"]}'::jsonb || p_app_metadata,
        '{}'::jsonb,
        now(), now(), now()
    )
    returning id;
$$;

-- Two tenant orgs + their users, memberships created through the real
-- provisioning path (app_metadata.org_id -> handle_new_user).
create function tests.create_two_orgs() returns void
language plpgsql
as $$
begin
    insert into public.organizations (id, name, slug) values
        (tests.org_a(), 'Tes Org A', 'tes-org-a'),
        (tests.org_b(), 'Tes Org B', 'tes-org-b');

    perform tests.create_supabase_user(tests.user_a1(), 'a1@tes.local',
        jsonb_build_object('org_id', tests.org_a(), 'org_role', 'owner'));
    perform tests.create_supabase_user(tests.user_a2(), 'a2@tes.local',
        jsonb_build_object('org_id', tests.org_a(), 'org_role', 'staff'));
    perform tests.create_supabase_user(tests.user_b1(), 'b1@tes.local',
        jsonb_build_object('org_id', tests.org_b(), 'org_role', 'owner'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Acting as a role (transaction-local, like `set local`)
-- ---------------------------------------------------------------------------
create function tests.authenticate_as(p_user uuid) returns void
language plpgsql
as $$
begin
    perform set_config('role', 'none', true);  -- back to the session user first
    perform set_config('request.jwt.claims',
        json_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', p_user::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    -- Guard against vacuous passes: if the switch did not take effect the
    -- caller would still be postgres (RLS bypassed) and every "sees nothing"
    -- assertion would be meaningless. Fail loudly instead.
    if current_user <> 'authenticated' or auth.uid() is distinct from p_user then
        raise exception 'tests.authenticate_as: role switch failed (current_user=%, auth.uid()=%)',
            current_user, auth.uid();
    end if;
end;
$$;

create function tests.authenticate_as_anon() returns void
language plpgsql
as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    perform set_config('role', 'anon', true);
    if current_user <> 'anon' or auth.uid() is not null then
        raise exception 'tests.authenticate_as_anon: role switch failed (current_user=%)', current_user;
    end if;
end;
$$;

create function tests.authenticate_as_service_role() returns void
language plpgsql
as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', 'service_role', true);
    perform set_config('role', 'service_role', true);
    if current_user <> 'service_role' then
        raise exception 'tests.authenticate_as_service_role: role switch failed (current_user=%)', current_user;
    end if;
end;
$$;

-- Back to the session user (postgres) to arrange fixtures or verify state.
create function tests.clear_authentication() returns void
language plpgsql
as $$
begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    perform set_config('role', 'none', true);
    if current_user = any (array['authenticated', 'anon', 'service_role']) then
        raise exception 'tests.clear_authentication: still running as %', current_user;
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reusable assertion sets (return pgTAP lines; call with select * from ...)
-- ---------------------------------------------------------------------------

-- Row count that ignores RLS (SECURITY DEFINER, owned by postgres, which has
-- BYPASSRLS). The assertion sets below call it while acting as a client role
-- to prove that the rows an "is empty" assertion must not see really exist,
-- so a denial can never pass just because the table is empty.
create function tests.rows_ignoring_rls(p_table text, p_where text default 'true')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_n bigint;
begin
    execute format('select count(*) from public.%I where %s', p_table, p_where) into v_n;
    return v_n;
end;
$$;

-- Tenant-isolation matrix for one org-scoped table, run as a member of p_own.
-- Emits 10 assertions (the first is the precondition that rows of another org
-- exist). p_vals is the VALUES list for p_cols with {org} standing
-- for the target org id; p_set is an innocuous SET clause; p_new_where picks
-- the row inserted by the first assertion (so the final delete never hits a
-- fixture row that other rows reference).
create function tests.check_tenant_table(
    p_table text,
    p_cols text,
    p_vals text,
    p_set text,
    p_new_where text,
    p_own uuid,
    p_other uuid
) returns setof text
language plpgsql
as $$
declare
    v_own   text := quote_literal(p_own);
    v_other text := quote_literal(p_other);
begin
    return next ok(
        tests.rows_ignoring_rls(p_table, format('org_id <> %s', v_own)) > 0,
        format('%s: precondition: rows of other orgs exist', p_table));
    return next lives_ok(
        format('insert into public.%I (%s) values (%s)', p_table, p_cols, replace(p_vals, '{org}', v_own)),
        format('%s: a member can insert a row for their own org', p_table));
    return next isnt_empty(
        format('select 1 from public.%I where org_id = %s', p_table, v_own),
        format('%s: a member can read their own org''s rows', p_table));
    return next is_empty(
        format('select 1 from public.%I where org_id <> %s', p_table, v_own),
        format('%s: a member reads no row of any other org', p_table));
    return next throws_ok(
        format('insert into public.%I (%s) values (%s)', p_table, p_cols, replace(p_vals, '{org}', v_other)),
        '42501', null,
        format('%s: a member cannot insert a row for another org', p_table));
    return next isnt_empty(
        format('update public.%I set %s where org_id = %s returning 1', p_table, p_set, v_own),
        format('%s: a member can update their own org''s rows', p_table));
    return next is_empty(
        format('update public.%I set %s where org_id <> %s returning 1', p_table, p_set, v_own),
        format('%s: a member updates no row of another org', p_table));
    return next throws_ok(
        format('update public.%I set org_id = %s where org_id = %s', p_table, v_other, v_own),
        '42501', null,
        format('%s: a member cannot move a row into another org', p_table));
    return next is_empty(
        format('delete from public.%I where org_id <> %s returning 1', p_table, v_own),
        format('%s: a member deletes no row of another org', p_table));
    return next isnt_empty(
        format('delete from public.%I where org_id = %s and (%s) returning 1', p_table, v_own, p_new_where),
        format('%s: a member can delete their own org''s row', p_table));
end;
$$;

-- The other direction, without writes of its own: a member of p_own sees,
-- updates and deletes nothing outside p_own (includes the seed org's rows).
-- Emits 4 assertions (the first is the precondition that foreign rows exist).
create function tests.check_cross_org_blind(
    p_table text,
    p_set text,
    p_own uuid
) returns setof text
language plpgsql
as $$
declare
    v_own text := quote_literal(p_own);
begin
    return next ok(
        tests.rows_ignoring_rls(p_table, format('org_id <> %s', v_own)) > 0,
        format('%s: precondition: foreign rows exist', p_table));
    return next is_empty(
        format('select 1 from public.%I where org_id <> %s', p_table, v_own),
        format('%s: a member of another org reads no foreign row', p_table));
    return next is_empty(
        format('update public.%I set %s where org_id <> %s returning 1', p_table, p_set, v_own),
        format('%s: a member of another org updates no foreign row', p_table));
    return next is_empty(
        format('delete from public.%I where org_id <> %s returning 1', p_table, v_own),
        format('%s: a member of another org deletes no foreign row', p_table));
end;
$$;

-- No row access at all for the current role (anon everywhere; authenticated on
-- the service-role-only tables). Emits 5 assertions (the first is the
-- precondition that the table is not empty).
create function tests.check_no_access(
    p_table text,
    p_cols text,
    p_vals text,
    p_set text,
    p_who text
) returns setof text
language plpgsql
as $$
begin
    return next ok(
        tests.rows_ignoring_rls(p_table) > 0,
        format('%s: precondition: the table has rows', p_table));
    return next is_empty(
        format('select 1 from public.%I', p_table),
        format('%s: %s reads no rows', p_table, p_who));
    return next throws_ok(
        format('insert into public.%I (%s) values (%s)', p_table, p_cols, p_vals),
        '42501', null,
        format('%s: %s cannot insert', p_table, p_who));
    return next is_empty(
        format('update public.%I set %s returning 1', p_table, p_set),
        format('%s: %s updates no rows', p_table, p_who));
    return next is_empty(
        format('delete from public.%I returning 1', p_table),
        format('%s: %s deletes no rows', p_table, p_who));
end;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Always-green check that the hooks ran (Supabase pgTAP guide pattern).
begin;
select plan(1);
select ok(true, 'test hooks installed');
select * from finish();
rollback;
