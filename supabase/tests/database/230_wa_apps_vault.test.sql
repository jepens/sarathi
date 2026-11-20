-- Per-client Meta apps with their WhatsApp secrets in Vault (0073; Fase 2 task
-- 2.1b, owner decision D6). whatsapp_apps is for the service role only (both
-- orgs' members and anon are checked in 010); this file pins its catalog, the
-- reshaped whatsapp_integrations, and the behaviour of the six service-role
-- RPCs: secrets stored encrypted and returned only through the RPCs, one app
-- and one number per org, a number bound to its own org's app, rotation, and
-- offboarding that leaves no Vault secret behind. Fake ids and secrets only.
begin;
select plan(46);

select tests.create_two_orgs();

-- ---------------------------------------------------------------------------
-- 1. Catalog
-- ---------------------------------------------------------------------------
select ok(
    not has_table_privilege('authenticated', 'public.whatsapp_apps',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'authenticated holds no table privilege on whatsapp_apps');
select ok(
    not has_any_column_privilege('authenticated', 'public.whatsapp_apps',
        'SELECT, INSERT, UPDATE, REFERENCES'),
    'authenticated holds no column privilege on whatsapp_apps');
select ok(
    not has_table_privilege('anon', 'public.whatsapp_apps',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'anon holds no table privilege on whatsapp_apps');
select ok(
    has_table_privilege('service_role', 'public.whatsapp_apps', 'SELECT')
    and has_table_privilege('service_role', 'public.whatsapp_apps', 'UPDATE'),
    'the service role can read and update whatsapp_apps (e.g. suspend an app)');
select is(
    (select string_agg(format('%s | %s | %s | %s | %s | %s',
                              policyname, permissive, cmd,
                              array_to_string(array(select unnest(roles) order by 1), ','),
                              coalesce(qual, '-'), coalesce(with_check, '-')), '; ')
       from pg_policies
      where schemaname = 'public' and tablename = 'whatsapp_apps'),
    'service_role only | PERMISSIVE | ALL | anon,authenticated | false | false',
    'the only policy on whatsapp_apps is the service-role-only deny policy');
select hasnt_column('public', 'whatsapp_integrations', 'access_token',
    'whatsapp_integrations keeps no plaintext access token');
select hasnt_column('public', 'whatsapp_integrations', 'app_secret',
    'whatsapp_integrations keeps no plaintext app secret');
select ok(has_function_privilege('service_role', f, 'execute'),
          format('%s: executable by service_role', f))
from unnest(array['public.wa_provision_app(uuid, text, text, text, text)',
                  'public.wa_provision_number(uuid, text, text, text)',
                  'public.wa_rotate_secret(uuid, text, text)',
                  'public.wa_webhook_app(text)',
                  'public.wa_org_send_credentials(uuid)',
                  'public.wa_offboard_org(uuid)']) f;

-- ---------------------------------------------------------------------------
-- 2. Provisioning: secrets go to Vault, out only through the RPCs
-- ---------------------------------------------------------------------------
create temp table t_a on commit drop as
select * from public.wa_provision_app(tests.org_a(), '91000000001',
    'appsecret-palsu-aaaa', 'token-palsu-aaaa-0123456789', 'verify-palsu-a');

select matches((select webhook_key from t_a), '^[A-Za-z0-9_-]{32}$',
    'the webhook key is 32 URL-safe characters');
select is(
    (select s.secret <> 'appsecret-palsu-aaaa' and s.secret <> 'token-palsu-aaaa-0123456789'
       from vault.secrets s join public.whatsapp_apps a on a.app_secret_id = s.id
      where a.id = (select app_id from t_a)),
    true,
    'Vault stores the app secret encrypted');
select is(
    (select app_secret from public.wa_webhook_app((select webhook_key from t_a))),
    'appsecret-palsu-aaaa',
    'wa_webhook_app returns the app secret for the key');
select is(
    (select org_id from public.wa_webhook_app((select webhook_key from t_a))),
    tests.org_a(),
    'wa_webhook_app returns the app''s org');
select is(
    (select verify_token_sha256 from public.wa_webhook_app((select webhook_key from t_a))),
    encode(extensions.digest('verify-palsu-a', 'sha256'), 'hex'),
    'the verify token is kept as its sha256 only');
select is_empty(
    $$ select * from public.wa_webhook_app('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') $$,
    'an unknown webhook key returns no row');
select is_empty(
    $$ select * from public.wa_org_send_credentials(tests.org_a()) $$,
    'an org without a number gets no send credentials');

select lives_ok(
    format($$ select public.wa_provision_number(%L, '110000000000001', '210000000000001', ' +62 811-0000-0001 ') $$,
           (select app_id from t_a)),
    'a number is added to the org''s app');
select results_eq(
    $$ select phone_number_id, waba_id, access_token, status, app_status
         from public.wa_org_send_credentials(tests.org_a()) $$,
    $$ values ('110000000000001'::text, '210000000000001'::text,
               'token-palsu-aaaa-0123456789'::text, 'active'::text, 'active'::text) $$,
    'wa_org_send_credentials returns the number and its app''s token');
select is(
    (select display_phone from public.whatsapp_integrations where org_id = tests.org_a()),
    '+62 811-0000-0001',
    'the display phone is trimmed');

-- ---------------------------------------------------------------------------
-- 3. One app and one number per org; numbers and apps are global
-- ---------------------------------------------------------------------------
select throws_ok(
    $$ select * from public.wa_provision_app(tests.org_a(), '91000000002',
           'appsecret-palsu-aaa2', 'token-palsu-aaa2-0123456789', 'verify') $$,
    '23505', null,
    'a second app for the same org is refused');
select throws_ok(
    format($$ select public.wa_provision_number(%L, '110000000000002', '210000000000001') $$,
           (select app_id from t_a)),
    '23505', null,
    'a second number for the same org is refused');

create temp table t_b on commit drop as
select * from public.wa_provision_app(tests.org_b(), '91000000003',
    'appsecret-palsu-bbbb', 'token-palsu-bbbb-0123456789', 'verify-palsu-b');

select throws_ok(
    $$ select * from public.wa_provision_app(tests.seed_org(), '91000000001',
           'appsecret-palsu-seed', 'token-palsu-seed-0123456789', 'verify') $$,
    '23505', null,
    'a Meta app id belongs to one org only');
select throws_ok(
    format($$ select public.wa_provision_number(%L, '110000000000001', '210000000000003') $$,
           (select app_id from t_b)),
    '23505', null,
    'a phone number id belongs to one org only');
select throws_ok(
    format($$ insert into public.whatsapp_integrations (org_id, app_id, phone_number_id, waba_id)
              values (%L, %L, '110000000000009', '210000000000009') $$,
           tests.org_b(), (select app_id from t_a)),
    '23503', null,
    'a number cannot be filed under another org''s app');
select throws_ok(
    format($$ select public.wa_provision_number(%L, 'bukan-angka', '210000000000003') $$,
           (select app_id from t_b)),
    '23514', null,
    'phone number and WABA ids must be numeric');

-- ---------------------------------------------------------------------------
-- 4. Input validation
-- ---------------------------------------------------------------------------
select throws_ok(
    $$ select * from public.wa_provision_app('cccccccc-0000-4000-8000-00000000000c', '91000000004',
           'appsecret-palsu-cccc', 'token-palsu-cccc-0123456789', 'verify') $$,
    '22023', 'wa_provision_app: unknown org',
    'an unknown org is refused');
select throws_ok(
    $$ select * from public.wa_provision_app(tests.seed_org(), 'app-123',
           'appsecret-palsu-seed', 'token-palsu-seed-0123456789', 'verify') $$,
    '22023', 'wa_provision_app: meta_app_id must be 5-25 digits',
    'a non-numeric Meta app id is refused');
select throws_ok(
    $$ select * from public.wa_provision_app(tests.seed_org(), '91000000005',
           'appsecret palsu seed', 'token-palsu-seed-0123456789', 'verify') $$,
    '22023', 'wa_provision_app: app secret must be 16-256 visible ASCII characters',
    'an app secret with spaces is refused');
select throws_ok(
    $$ select * from public.wa_provision_app(tests.seed_org(), '91000000005',
           'appsecret-palsu-seed', E'token-palsu-seed\n0123456789', 'verify') $$,
    '22023', 'wa_provision_app: access token must be 20-4096 visible ASCII characters',
    'an access token with a newline is refused');
select throws_ok(
    $$ select public.wa_provision_number('cccccccc-0000-4000-8000-00000000000c', '110000000000005', '210000000000005') $$,
    '22023', 'wa_provision_number: unknown app',
    'a number for an unknown app is refused');

-- ---------------------------------------------------------------------------
-- 5. Rotation: the same Vault row is updated
-- ---------------------------------------------------------------------------
select lives_ok(
    format($$ select public.wa_rotate_secret(%L, 'access_token', 'token-baru-aaaa-0123456789') $$,
           (select app_id from t_a)),
    'the access token is rotated');
select is(
    (select access_token from public.wa_org_send_credentials(tests.org_a())),
    'token-baru-aaaa-0123456789',
    'sends use the rotated token at once');
select lives_ok(
    format($$ select public.wa_rotate_secret(%L, 'app_secret', 'appsecret-baru-aaaa') $$,
           (select app_id from t_a)),
    'the app secret is rotated');
select is(
    (select app_secret from public.wa_webhook_app((select webhook_key from t_a))),
    'appsecret-baru-aaaa',
    'the webhook checks with the rotated app secret at once');
select lives_ok(
    format($$ select public.wa_rotate_secret(%L, 'verify_token', 'verify-baru-a') $$,
           (select app_id from t_a)),
    'the verify token is rotated');
select is(
    (select verify_token_sha256 from public.wa_webhook_app((select webhook_key from t_a))),
    encode(extensions.digest('verify-baru-a', 'sha256'), 'hex'),
    'the rotated verify token''s sha256 is stored');
select is(
    (select count(*)::int from vault.secrets
      where name like format('wa_app:%s:%%', (select app_id from t_a))),
    2,
    'rotation keeps exactly two Vault secrets per app (updated in place)');
select throws_ok(
    format($$ select public.wa_rotate_secret(%L, 'pin', '123456') $$, (select app_id from t_a)),
    '22023', 'wa_rotate_secret: kind must be app_secret, access_token or verify_token',
    'an unknown secret kind is refused');
select throws_ok(
    format($$ select public.wa_rotate_secret(%L, 'access_token', 'pendek') $$, (select app_id from t_a)),
    '22023', 'wa_rotate_secret: invalid access_token',
    'a malformed rotated token is refused');

-- ---------------------------------------------------------------------------
-- 6. Offboarding: an org with an app cannot be deleted until it is offboarded
-- ---------------------------------------------------------------------------
select throws_ok(
    format($$ delete from public.organizations where id = %L $$, tests.org_b()),
    '23503', null,
    'an org with a WhatsApp app cannot be deleted directly');
select lives_ok(
    $$ select public.wa_offboard_org(tests.org_b()) $$,
    'the org is offboarded');
select is(
    (select count(*)::int from vault.secrets
      where name like format('wa_app:%s:%%', (select app_id from t_b)))
    + (select count(*)::int from public.whatsapp_apps where org_id = tests.org_b())
    + (select count(*)::int from public.whatsapp_integrations where org_id = tests.org_b()),
    0,
    'offboarding leaves no app, number or Vault secret behind');

select * from finish();
rollback;
