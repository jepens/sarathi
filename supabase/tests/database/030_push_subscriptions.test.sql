-- push_subscriptions: rows belong to ONE user inside an org they are a member
-- of (0058, audit KEA-3 / KEA-23). A colleague in the same org must not see,
-- hijack or delete another member's device; nobody can register a device for
-- an org they do not belong to.
begin;
select plan(13);

select tests.create_two_orgs();

insert into public.push_subscriptions (org_id, user_id, endpoint, p256dh, auth) values
    (tests.org_a(), tests.user_a1(), 'https://push.invalid/a1', 'k', 'a'),
    (tests.org_a(), tests.user_a2(), 'https://push.invalid/a2', 'k', 'a'),
    (tests.org_b(), tests.user_b1(), 'https://push.invalid/b1', 'k', 'a');

select tests.authenticate_as(tests.user_a1());

select results_eq(
    $$ select endpoint from public.push_subscriptions $$,
    array['https://push.invalid/a1'],
    'a member sees only their own device (not a colleague''s, not another org''s)');
select lives_ok(
    $$ insert into public.push_subscriptions (org_id, endpoint, p256dh, auth)
       values (tests.org_a(), 'https://push.invalid/a1-baru', 'k', 'a') $$,
    'a member registers a device for their own org');
select results_eq(
    $$ select user_id from public.push_subscriptions where endpoint = 'https://push.invalid/a1-baru' $$,
    array[tests.user_a1()],
    'user_id defaults to the signed-in user');
select throws_ok(
    $$ insert into public.push_subscriptions (org_id, user_id, endpoint, p256dh, auth)
       values (tests.org_a(), tests.user_a2(), 'https://push.invalid/palsu', 'k', 'a') $$,
    '42501', null,
    'a member cannot register a device in a colleague''s name');
select throws_ok(
    $$ insert into public.push_subscriptions (org_id, endpoint, p256dh, auth)
       values (tests.org_b(), 'https://push.invalid/palsu', 'k', 'a') $$,
    '42501', null,
    'a member cannot register a device for another org');
select throws_ok(
    $$ update public.push_subscriptions set user_id = tests.user_a2()
       where endpoint = 'https://push.invalid/a1' $$,
    '42501', null,
    'a member cannot hand their device over to a colleague');
select is_empty(
    $$ update public.push_subscriptions set user_agent = 'x'
       where endpoint in ('https://push.invalid/a2', 'https://push.invalid/b1') returning 1 $$,
    'a member updates no other user''s device');
select is_empty(
    $$ delete from public.push_subscriptions
       where endpoint in ('https://push.invalid/a2', 'https://push.invalid/b1') returning 1 $$,
    'a member deletes no other user''s device');
select isnt_empty(
    $$ delete from public.push_subscriptions where endpoint = 'https://push.invalid/a1' returning 1 $$,
    'a member removes their own device');

select tests.authenticate_as(tests.user_a2());
select results_eq(
    $$ select endpoint from public.push_subscriptions $$,
    array['https://push.invalid/a2'],
    'the colleague sees only their own device');

select tests.authenticate_as(tests.user_b1());
select results_eq(
    $$ select endpoint from public.push_subscriptions $$,
    array['https://push.invalid/b1'],
    'the other org sees only its own device');

select tests.authenticate_as_anon();
select is_empty($$ select 1 from public.push_subscriptions $$, 'anon reads no device');

select tests.clear_authentication();
select results_eq(
    $$ select endpoint from public.push_subscriptions
       where endpoint in ('https://push.invalid/a2', 'https://push.invalid/b1') order by 1 $$,
    array['https://push.invalid/a2', 'https://push.invalid/b1'],
    'the colleague''s and the other org''s devices are intact');

select * from finish();
rollback;
