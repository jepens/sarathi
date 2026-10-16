-- platform_settings: deployment-level config readable/writable by the service
-- role only (migration 0061; tracker 1.7, audit KEA-9). verify_webhook_token()
-- reads it first and falls back to the legacy seed-org app_settings row during
-- the rollout.
begin;
select plan(20);

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
-- 2. The migration copied the platform keys of the seed org
-- ---------------------------------------------------------------------------
select is((select value from public.platform_settings where key = 'default_org_id'),
          (select value from public.app_settings where key = 'default_org_id' and org_id = tests.seed_org()),
          'default_org_id was copied from app_settings');

insert into public.platform_settings (key, value) values ('whatsapp_verify_token', 'rahasia-platform')
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
select is((select value from public.platform_settings where key = 'whatsapp_verify_token'),
          'rahasia-platform', 'service_role reads platform_settings');
select is(public.verify_webhook_token('rahasia-platform'), true,
          'verify_webhook_token: accepts the platform token');
select is(public.verify_webhook_token('salah'), false,
          'verify_webhook_token: rejects another token');

-- ---------------------------------------------------------------------------
-- 4. verify_webhook_token fallback + fail closed
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
delete from public.platform_settings where key = 'whatsapp_verify_token';
delete from public.app_settings where key = 'whatsapp_verify_token';
insert into public.app_settings (org_id, key, value)
values (tests.seed_org(), 'whatsapp_verify_token', 'rahasia-lama');

select tests.authenticate_as_service_role();
select is(public.verify_webhook_token('rahasia-lama'), true,
          'verify_webhook_token: falls back to the legacy seed-org app_settings row');

select tests.clear_authentication();
delete from public.app_settings where key = 'whatsapp_verify_token';
-- Only the seed org's legacy row counts: a tenant cannot plant a token.
alter table public.app_settings drop constraint app_settings_key_key;
insert into public.app_settings (org_id, key, value)
values (tests.org_a(), 'whatsapp_verify_token', 'token-tenant');
select tests.authenticate_as_service_role();
select is(public.verify_webhook_token('token-tenant'), false,
          'verify_webhook_token: ignores a tenant''s app_settings row');
select is(public.verify_webhook_token(''), false,
          'verify_webhook_token: no token configured fails closed');

select * from finish();
rollback;
