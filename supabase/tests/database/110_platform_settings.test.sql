-- platform_settings: deployment-level config readable/writable by the service
-- role only (migrations 0061 / 0062; tracker 1.7, audit KEA-9). Its only key
-- is default_org_id: the contract 0074 (2.2d) dropped verify_webhook_token()
-- and the webhook verify token / URL rows (every Meta app has its own, 0073).
begin;
select plan(16);

select tests.create_two_orgs();

-- ---------------------------------------------------------------------------
-- 1. Catalog: RLS on, no policies, no privileges for the client roles
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.platform_settings'::regclass), true,
          'platform_settings has RLS enabled');
select is_empty(
    $$ select policyname from pg_policies where schemaname = 'public' and tablename = 'platform_settings' $$,
    'platform_settings has no policies');
select is(has_table_privilege(r, 'public.platform_settings', p), false,
          format('platform_settings: %s has no %s privilege', r, p))
from unnest(array['anon', 'authenticated']) r,
     unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;

-- ---------------------------------------------------------------------------
-- 2. The migrations moved the platform keys of the seed org
-- ---------------------------------------------------------------------------
select is((select value from public.platform_settings where key = 'default_org_id'),
          tests.seed_org()::text,
          'default_org_id (the seed org) lives in platform_settings');

insert into public.platform_settings (key, value) values ('kunci_uji', 'nilai-uji')
on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------------------
-- 3. Client roles cannot read or write it
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_a1());
select throws_ok($$ select * from public.platform_settings $$, '42501', null,
                 'authenticated cannot read platform_settings');
select throws_ok($$ update public.platform_settings set value = 'x' where key = 'default_org_id' $$,
                 '42501', null, 'authenticated cannot update platform_settings');

select tests.authenticate_as_anon();
select throws_ok($$ select * from public.platform_settings $$, '42501', null,
                 'anon cannot read platform_settings');

select tests.authenticate_as_service_role();
select is((select value from public.platform_settings where key = 'kunci_uji'),
          'nilai-uji', 'service_role reads platform_settings');

-- ---------------------------------------------------------------------------
-- 4. The legacy webhook verify token reader is gone (contract 0074)
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
select hasnt_function('public', 'verify_webhook_token', array['text'],
                      'verify_webhook_token(text) no longer exists');

select * from finish();
rollback;
