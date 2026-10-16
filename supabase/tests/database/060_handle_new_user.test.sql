-- handle_new_user (0060, audit KEA-1): a new auth user gets a membership ONLY
-- when the platform provisions it with app_metadata.org_id; never an automatic
-- seat in the seed org, never a self-chosen org via user_metadata, never a new
-- org minted at sign-up.
begin;
select plan(11);

-- Baseline taken before the fixture so the counts below hold on any local
-- database, not only on a freshly reset one.
create temp table baseline on commit drop as
    select count(*)::int as orgs from public.organizations;

insert into public.organizations (id, name) values (tests.org_a(), 'Tes Org A');

select is(
    (select count(*)::int from public.organizations),
    (select orgs + 1 from baseline), 'fixture: org A was added to the existing orgs');

-- 1. No app_metadata: no membership at all (and no org created).
select tests.create_supabase_user('00000000-0000-4000-8000-0000000000c1', 'c1@tes.local');
select is_empty(
    $$ select 1 from public.organization_members where user_id = '00000000-0000-4000-8000-0000000000c1' $$,
    'no app_metadata.org_id: the user gets no membership');

-- 2. org_id + explicit role.
select tests.create_supabase_user('00000000-0000-4000-8000-0000000000c2', 'c2@tes.local',
    jsonb_build_object('org_id', tests.org_a(), 'org_role', 'admin'));
select results_eq(
    $$ select org_id, role::text from public.organization_members
       where user_id = '00000000-0000-4000-8000-0000000000c2' $$,
    format('values (%L::uuid, %L)', tests.org_a(), 'admin'),
    'app_metadata.org_id + org_role admin: joins that org as admin');

-- 3. org_id without a role -> staff.
select tests.create_supabase_user('00000000-0000-4000-8000-0000000000c3', 'c3@tes.local',
    jsonb_build_object('org_id', tests.org_a()));
select results_eq(
    $$ select role::text from public.organization_members
       where user_id = '00000000-0000-4000-8000-0000000000c3' $$,
    array['staff'],
    'app_metadata.org_id without org_role: joins as staff');

-- 4. Unknown role value -> staff (never escalates).
select tests.create_supabase_user('00000000-0000-4000-8000-0000000000c4', 'c4@tes.local',
    jsonb_build_object('org_id', tests.org_a(), 'org_role', 'superadmin'));
select results_eq(
    $$ select role::text from public.organization_members
       where user_id = '00000000-0000-4000-8000-0000000000c4' $$,
    array['staff'],
    'an unknown org_role falls back to staff');

-- 5. Malformed org_id -> ignored.
select tests.create_supabase_user('00000000-0000-4000-8000-0000000000c5', 'c5@tes.local',
    '{"org_id": "bukan-uuid"}'::jsonb);
select is_empty(
    $$ select 1 from public.organization_members where user_id = '00000000-0000-4000-8000-0000000000c5' $$,
    'a malformed org_id is ignored (no membership)');

-- 6. Well-formed but unknown org -> user creation fails loudly (FK).
select throws_ok(
    $$ select tests.create_supabase_user('00000000-0000-4000-8000-0000000000c6', 'c6@tes.local',
           '{"org_id": "99999999-9999-4999-8999-999999999999"}'::jsonb) $$,
    '23503', null,
    'an unknown org_id makes user creation fail');

-- 7. user_metadata is user-controlled (sign-up form): it must be ignored.
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000000c7', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'c7@tes.local', '{}'::jsonb,
        jsonb_build_object('org_id', tests.org_a(), 'org_role', 'owner', 'org_name', 'Org Saya'),
        now(), now());
select is_empty(
    $$ select 1 from public.organization_members where user_id = '00000000-0000-4000-8000-0000000000c7' $$,
    'org_id / org_role in user_metadata are ignored');

-- Global effects.
select is_empty(
    $$ select 1 from public.organization_members m
       where m.org_id = '5a11e024-0001-4000-8000-000000000001'
         and m.user_id::text like '00000000-0000-4000-8000-0000000000c%' $$,
    'nobody was added to the seed org');
select is(
    (select count(*)::int from public.organizations),
    (select orgs + 1 from baseline), 'no organization was created by sign-up');
select is(
    (select count(*)::int from public.organization_members where org_id = tests.org_a()),
    3, 'org A has exactly the three provisioned members');

select * from finish();
rollback;
