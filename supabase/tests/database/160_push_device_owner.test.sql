-- Push device owner (migration 0065; tracker 1.5, owner decision D19, audit
-- KUA-5 / KEA-23): a browser endpoint has ONE row, owned by whoever is signed
-- in on it now. register_push_subscription moves the device to the caller,
-- stamped with the caller's org (membership checked) and user, after checking
-- the input; a plain upsert under RLS cannot take over another user's row.
begin;
select plan(19);

select tests.create_two_orgs();
-- A signed-in user who is a member of no org (0060: no auto-join).
select tests.create_supabase_user('cccccccc-1111-4000-8000-0000000000c1', 'c1@tes.local');

select col_is_unique('public', 'push_subscriptions', 'endpoint',
    'push_subscriptions.endpoint stays globally unique: one owner per device (D19)');

-- ---------------------------------------------------------------------------
-- 1. a1 registers the browser
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_a1());
select lives_ok(
    $$ select public.register_push_subscription(tests.org_a(), 'https://push.invalid/perangkat',
           'p-a1', 'a-a1', 'Browser A') $$,
    'a1 registers the device through the RPC');
select results_eq(
    $$ select org_id, user_id, p256dh, auth, user_agent from public.push_subscriptions
       where endpoint = 'https://push.invalid/perangkat' $$,
    $$ values (tests.org_a(), tests.user_a1(), 'p-a1', 'a-a1', 'Browser A') $$,
    'the row is stamped with a1''s org and user');
select isnt((select id::text from public.push_subscriptions
             where endpoint = 'https://push.invalid/perangkat'), null::text,
    'precondition: a1''s device row exists (its id is kept to check the move)');
select set_config('tests.device_id',
    (select id::text from public.push_subscriptions
     where endpoint = 'https://push.invalid/perangkat'), true);

-- ---------------------------------------------------------------------------
-- 2. b1 (org B) signs in on the same browser
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_b1());
select throws_ok(
    $$ insert into public.push_subscriptions (org_id, user_id, endpoint, p256dh, auth)
       values (tests.org_b(), tests.user_b1(), 'https://push.invalid/perangkat', 'p-b1', 'a-b1')
       on conflict (endpoint) do update set org_id = excluded.org_id, user_id = excluded.user_id $$,
    '42501', 'new row violates row-level security policy (USING expression) for table "push_subscriptions"',
    'without the RPC, b1''s upsert fails: RLS hides a1''s row (why the RPC exists)');
select lives_ok(
    $$ select public.register_push_subscription(tests.org_b(), 'https://push.invalid/perangkat',
           'p-b1', 'a-b1', repeat('x', 500)) $$,
    'b1 registers the same device through the RPC');

select tests.clear_authentication();
select results_eq(
    $$ select id::text, org_id, user_id, p256dh, auth, length(user_agent) from public.push_subscriptions
       where endpoint = 'https://push.invalid/perangkat' $$,
    $$ values (current_setting('tests.device_id'), tests.org_b(), tests.user_b1(), 'p-b1', 'a-b1', 400) $$,
    'still one row with the same id, moved to org B / b1 with b1''s keys (user agent cut to 400)');

select tests.authenticate_as(tests.user_a1());
select is_empty(
    $$ select 1 from public.push_subscriptions where endpoint = 'https://push.invalid/perangkat' $$,
    'a1 no longer sees the device: org A stops pushing to it');

-- ---------------------------------------------------------------------------
-- 3. Refusals
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_b1());
select throws_ok(
    $$ select public.register_push_subscription(tests.org_a(), 'https://push.invalid/lain', 'p', 'a') $$,
    '42501', 'not authorized to register push devices for this org',
    'b1 cannot register a device for org A (not a member)');

select tests.authenticate_as('cccccccc-1111-4000-8000-0000000000c1');
select throws_ok(
    $$ select public.register_push_subscription(tests.org_a(), 'https://push.invalid/lain', 'p', 'a') $$,
    '42501', 'not authorized to register push devices for this org',
    'a signed-in user without a membership cannot register a device');

-- The RPC's own input checks (https scheme + host character, length limits, keys set).
select tests.authenticate_as(tests.user_a1());
select throws_ok(
    format('select public.register_push_subscription(%L, %L, %L, %L)', tests.org_a(), v.endpoint, v.p256dh, v.auth),
    '22023', 'invalid push subscription',
    'input check: ' || v.label)
from (values
    ('http://push.invalid/x',                       'p',              'a',  'an http:// endpoint is refused'),
    ('https://',                                    'p',              'a',  'an endpoint without a host is refused'),
    ('https://push.invalid/' || repeat('x', 2028),  'p',              'a',  'an endpoint longer than 2048 characters is refused'),
    ('https://push.invalid/x',                      '',               'a',  'an empty p256dh key is refused'),
    ('https://push.invalid/x',                      repeat('k', 257), 'a',  'a p256dh key longer than 256 characters is refused'),
    ('https://push.invalid/x',                      'p',              '',   'an empty auth key is refused'),
    ('https://push.invalid/x',                      'p',              null, 'a missing auth key is refused')
) as v(endpoint, p256dh, auth, label);

select tests.authenticate_as_anon();
select throws_ok(
    $$ select public.register_push_subscription(tests.org_a(), 'https://push.invalid/anon', 'p', 'a') $$,
    '42501', 'permission denied for function register_push_subscription',
    'anon cannot execute the RPC');

select tests.clear_authentication();
select is(
    (select count(*)::int from public.push_subscriptions where endpoint like 'https://push.invalid/%'),
    1,
    'the refused calls wrote nothing: only the moved device exists');

select * from finish();
rollback;
