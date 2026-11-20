-- Tenant isolation on every org-scoped table (tracker 1.2 / 1.14, audit KUA-13).
--
-- Two tenant orgs (A, B) + the seed org. For each table a member of org A can
-- read / insert / update / delete its own org's rows and can NOT read, insert,
-- update, delete or re-home rows of any other org; a member of org B sees
-- nothing outside org B; anon holds no table privilege at all (0063), so every
-- statement is refused before RLS. message_queue and rate_limits are
-- service-role only through RLS; whatsapp_integrations and whatsapp_apps,
-- which hold tenant WhatsApp numbers and Vault ids, grant a member no table
-- privilege at all (0069, 0073), so every statement is refused before RLS as
-- for anon. organizations /
-- organization_members are read-only for members (no self-service membership
-- or role escalation).
-- chat_labels and push_subscriptions have their own files (extra rules).
begin;
select plan(332);

select tests.create_two_orgs();

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres, RLS bypassed): one row per org per table. The same
-- customer phone exists in both orgs (composite keys since 0034). Every
-- assertion set first checks (ignoring RLS) that the rows it must not see
-- exist, so no denial passes on an empty table.
-- ---------------------------------------------------------------------------
insert into public.whatsapp_chats (org_id, phone_number, contact_name) values
    (tests.org_a(), '628111', 'Pelanggan A'),
    (tests.org_b(), '628111', 'Pelanggan B');
insert into public.whatsapp_messages (org_id, phone_number, role, content) values
    (tests.org_a(), '628111', 'user', 'fixture A'),
    (tests.org_b(), '628111', 'user', 'fixture B');
insert into public.orders (org_id, customer_phone, customer_name) values
    (tests.org_a(), '628111', 'fixture A'),
    (tests.org_b(), '628111', 'fixture B');
insert into public.proposals (org_id, lead_phone, source, proposal_ref) values
    (tests.org_a(), '628111', 'generated', 'fixture A'),
    (tests.org_b(), '628111', 'generated', 'fixture B');
insert into public.vendors (org_id, name, category) values
    (tests.org_a(), 'fixture A', 'venue'),
    (tests.org_b(), 'fixture B', 'venue');
insert into public.documents (org_id, content) values
    (tests.org_a(), 'fixture A'),
    (tests.org_b(), 'fixture B');
insert into public.kb_sources (org_id, title, content) values
    (tests.org_a(), 'fixture A', 'isi'),
    (tests.org_b(), 'fixture B', 'isi');
insert into public.products (org_id, name, price) values
    (tests.org_a(), 'fixture A', 1000),
    (tests.org_b(), 'fixture B', 1000);
insert into public.system_message (org_id, name, content) values
    (tests.org_a(), 'fixture A', 'isi'),
    (tests.org_b(), 'fixture B', 'isi');
insert into public.app_settings (org_id, key, value) values
    (tests.org_a(), 'fixture_a', 'v'),
    (tests.org_b(), 'fixture_b', 'v');
insert into public.labels (org_id, name) values
    (tests.org_a(), 'fixture A'),
    (tests.org_b(), 'fixture B');
insert into public.quick_replies (org_id, shortcut, content) values
    (tests.org_a(), 'fixture', 'isi'),
    (tests.org_b(), 'fixture', 'isi');
-- One row per org at most (org_id is the primary key): only org B gets a
-- fixture; the org A member creates its own row in the matrix below.
insert into public.business_profiles (org_id, business_name) values
    (tests.org_b(), 'fixture B');
-- whatsapp_apps / whatsapp_integrations (service role only, 0069 and 0073):
-- an app and a number for org B and the seed org, so every refusal below is
-- checked against rows that exist. Fake ids and secrets only.
select public.wa_provision_number(
    (select app_id from public.wa_provision_app(tests.org_b(), '90000000001',
        'appsecret-palsu-0001', 'token-palsu-0001-abcdefgh', 'verify-palsu')),
    '100000000000001', '200000000000001');
select public.wa_provision_number(
    (select app_id from public.wa_provision_app(tests.seed_org(), '90000000002',
        'appsecret-palsu-0002', 'token-palsu-0002-abcdefgh', 'verify-palsu')),
    '100000000000002', '200000000000002');
insert into public.chat_labels (org_id, phone_number, label_id)
select l.org_id, '628111', l.id from public.labels l
where l.org_id in (tests.org_a(), tests.org_b()) and l.name like 'fixture %';
insert into public.push_subscriptions (org_id, user_id, endpoint, p256dh, auth) values
    (tests.org_a(), tests.user_a1(), 'https://push.invalid/fixture-a', 'k', 'a'),
    (tests.org_b(), tests.user_b1(), 'https://push.invalid/fixture-b', 'k', 'a');
insert into public.message_queue (org_id, phone_number, message_text) values
    (tests.org_a(), '628111', 'fixture A');
insert into public.rate_limits (identifier) values
    (tests.org_a()::text || ':628111');

-- ---------------------------------------------------------------------------
-- 1. Member of org A: full access to org A, none to other orgs (13 x 10)
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_a1());
select is(current_user::text, 'authenticated', 'acting as a member: role is authenticated (RLS applies)');
select is(auth.uid(), tests.user_a1(), 'acting as a member: auth.uid() is user a1');

select * from tests.check_tenant_table('whatsapp_chats',
    'org_id, phone_number', $$ {org}, 'tst-new-chat' $$,
    $$ notes = 'diubah' $$, $$ phone_number = 'tst-new-chat' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('whatsapp_messages',
    'org_id, phone_number, role, content', $$ {org}, '628111', 'user', 'tst-new' $$,
    $$ status = 'read' $$, $$ content = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('orders',
    'org_id, customer_name', $$ {org}, 'tst-new' $$,
    $$ venue = 'diubah' $$, $$ customer_name = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('proposals',
    'org_id, lead_phone, source, proposal_ref', $$ {org}, '628111', 'generated', 'tst-new' $$,
    $$ intro_note = 'diubah' $$, $$ proposal_ref = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('vendors',
    'org_id, name, category', $$ {org}, 'tst-new', 'other' $$,
    $$ notes = 'diubah' $$, $$ name = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('documents',
    'org_id, content', $$ {org}, 'tst-new' $$,
    $$ metadata = '{"diubah": true}'::jsonb $$, $$ content = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('kb_sources',
    'org_id, title, content', $$ {org}, 'tst-new-' || gen_random_uuid(), 'isi' $$,
    $$ content = 'diubah' $$, $$ title like 'tst-new-%' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('products',
    'org_id, name, price', $$ {org}, 'tst-new', 1000 $$,
    $$ description = 'diubah' $$, $$ name = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('system_message',
    'org_id, name, content', $$ {org}, 'tst-new-' || gen_random_uuid(), 'isi' $$,
    $$ description = 'diubah' $$, $$ name like 'tst-new-%' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('app_settings',
    'org_id, key, value', $$ {org}, 'tst-new-' || gen_random_uuid(), 'v' $$,
    $$ description = 'diubah' $$, $$ key like 'tst-new-%' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('labels',
    'org_id, name', $$ {org}, 'tst-new' $$,
    $$ color = 'red' $$, $$ name = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('quick_replies',
    'org_id, shortcut, content', $$ {org}, 'tst-new', 'isi' $$,
    $$ content = 'diubah' $$, $$ shortcut = 'tst-new' $$,
    tests.org_a(), tests.org_b());
select * from tests.check_tenant_table('business_profiles',
    'org_id, business_name', $$ {org}, 'tst-new' $$,
    $$ website = 'diubah' $$, $$ business_name = 'tst-new' $$,
    tests.org_a(), tests.org_b());

-- Service-role-only tables: even the member's own org rows are invisible.
select * from tests.check_no_access('message_queue',
    'org_id, phone_number, message_text', $$ tests.org_a(), '628111', 'tst' $$,
    $$ status = 'failed' $$, 'a member of org A');
select * from tests.check_no_access('rate_limits',
    'identifier', $$ 'tst' $$,
    $$ request_count = 99 $$, 'a member of org A');
-- whatsapp_integrations and whatsapp_apps (0069, 0073): no table privilege, so
-- a member's statements are refused before RLS, even on its own org's row.
select * from tests.check_no_privilege('whatsapp_integrations',
    'org_id, phone_number_id, waba_id', $$ tests.org_a(), '100000000000009', '200000000000009' $$,
    $$ display_phone = 'diubah' $$, 'a member of org A');
select * from tests.check_no_privilege('whatsapp_apps',
    'org_id, meta_app_id', $$ tests.org_a(), '90000000009' $$,
    $$ status = 'suspended' $$, 'a member of org A');

-- organizations: read own org only; no client-side writes at all.
select results_eq(
    $$ select id from public.organizations $$,
    array[tests.org_a()],
    'organizations: a member sees only their own org');
select throws_ok(
    $$ insert into public.organizations (name) values ('Org palsu') $$,
    '42501', null,
    'organizations: a member cannot create an org');
select is_empty(
    format('update public.organizations set name = %L where id = %L returning 1', 'diubah', tests.org_b()),
    'organizations: a member cannot rename another org');
select is_empty(
    format('update public.organizations set name = %L where id = %L returning 1', 'diubah', tests.org_a()),
    'organizations: a member cannot rename their own org (no write policy)');
select is_empty(
    $$ delete from public.organizations returning 1 $$,
    'organizations: a member deletes no org');

-- organization_members: own membership rows only; no self-service changes.
select results_eq(
    $$ select org_id, user_id, role::text from public.organization_members $$,
    format('values (%L::uuid, %L::uuid, %L)', tests.org_a(), tests.user_a1(), 'owner'),
    'organization_members: a member sees only their own membership row');
select throws_ok(
    format('insert into public.organization_members (org_id, user_id, role) values (%L, %L, %L)',
           tests.org_b(), tests.user_a1(), 'owner'),
    '42501', null,
    'organization_members: a member cannot join another org');
select throws_ok(
    format('insert into public.organization_members (org_id, user_id, role) values (%L, %L, %L)',
           tests.org_a(), tests.user_b1(), 'staff'),
    '42501', null,
    'organization_members: a member cannot add users to their org (platform-provisioned only)');
select is_empty(
    format('update public.organization_members set role = %L where user_id = %L returning 1',
           'owner', tests.user_a2()),
    'organization_members: a member cannot change roles');
select is_empty(
    $$ delete from public.organization_members returning 1 $$,
    'organization_members: a member deletes no membership');

-- ---------------------------------------------------------------------------
-- 2. Member of org B: blind to org A and the seed org (13 x 4)
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_b1());
select is(auth.uid(), tests.user_b1(), 'acting as a member of org B: auth.uid() is user b1');

select * from tests.check_cross_org_blind('whatsapp_chats', $$ notes = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('whatsapp_messages', $$ status = 'read' $$, tests.org_b());
select * from tests.check_cross_org_blind('orders', $$ venue = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('proposals', $$ intro_note = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('vendors', $$ notes = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('documents', $$ content = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('kb_sources', $$ content = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('products', $$ description = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('system_message', $$ description = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('app_settings', $$ description = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('labels', $$ color = 'red' $$, tests.org_b());
select * from tests.check_cross_org_blind('quick_replies', $$ content = 'diubah' $$, tests.org_b());
select * from tests.check_cross_org_blind('business_profiles', $$ website = 'diubah' $$, tests.org_b());
select * from tests.check_no_privilege('whatsapp_integrations',
    'org_id, phone_number_id, waba_id', $$ tests.org_b(), '100000000000008', '200000000000008' $$,
    $$ display_phone = 'diubah' $$, 'a member of org B');
select * from tests.check_no_privilege('whatsapp_apps',
    'org_id, meta_app_id', $$ tests.org_b(), '90000000008' $$,
    $$ status = 'suspended' $$, 'a member of org B');

-- ---------------------------------------------------------------------------
-- 3. anon: no privilege on any app table (0063), every statement refused with
--    42501 before RLS is consulted (20 x 5)
-- ---------------------------------------------------------------------------
select tests.authenticate_as_anon();
select is(current_user::text, 'anon', 'acting as anon: role is anon');

select * from tests.check_anon_denied('whatsapp_chats',
    'org_id, phone_number', $$ tests.org_a(), 'anon' $$, $$ notes = 'x' $$);
select * from tests.check_anon_denied('whatsapp_messages',
    'org_id, phone_number, role, content', $$ tests.org_a(), '628111', 'user', 'x' $$, $$ content = 'x' $$);
select * from tests.check_anon_denied('orders',
    'org_id, customer_name', $$ tests.org_a(), 'x' $$, $$ venue = 'x' $$);
select * from tests.check_anon_denied('proposals',
    'org_id, lead_phone, source, proposal_ref', $$ tests.org_a(), '628111', 'generated', 'x' $$, $$ intro_note = 'x' $$);
select * from tests.check_anon_denied('vendors',
    'org_id, name, category', $$ tests.org_a(), 'x', 'other' $$, $$ notes = 'x' $$);
select * from tests.check_anon_denied('documents',
    'org_id, content', $$ tests.org_a(), 'x' $$, $$ content = 'x' $$);
select * from tests.check_anon_denied('kb_sources',
    'org_id, title, content', $$ tests.org_a(), 'anon-x', 'x' $$, $$ content = 'x' $$);
select * from tests.check_anon_denied('products',
    'org_id, name, price', $$ tests.org_a(), 'x', 1 $$, $$ description = 'x' $$);
select * from tests.check_anon_denied('system_message',
    'org_id, name, content', $$ tests.org_a(), 'anon-x', 'x' $$, $$ description = 'x' $$);
select * from tests.check_anon_denied('app_settings',
    'org_id, key, value', $$ tests.org_a(), 'anon-x', 'x' $$, $$ description = 'x' $$);
select * from tests.check_anon_denied('labels',
    'org_id, name', $$ tests.org_a(), 'anon-x' $$, $$ color = 'red' $$);
-- label_id is a literal uuid: anon may not read labels either, and the
-- refusal must be about chat_labels itself.
select * from tests.check_anon_denied('chat_labels',
    'org_id, phone_number, label_id', $$ tests.org_a(), '628111', gen_random_uuid() $$,
    $$ created_at = now() $$);
select * from tests.check_anon_denied('quick_replies',
    'org_id, shortcut, content', $$ tests.org_a(), 'anon-x', 'x' $$, $$ content = 'x' $$);
select * from tests.check_anon_denied('push_subscriptions',
    'org_id, endpoint, p256dh, auth, user_id',
    $$ tests.org_a(), 'https://push.invalid/anon', 'k', 'a', tests.user_a1() $$,
    $$ user_agent = 'x' $$);
select * from tests.check_anon_denied('business_profiles',
    'org_id, business_name', $$ tests.org_a(), 'x' $$, $$ website = 'x' $$);
select * from tests.check_anon_denied('whatsapp_integrations',
    'org_id, phone_number_id, waba_id', $$ tests.org_a(), '100000000000007', '200000000000007' $$, $$ display_phone = 'x' $$);
select * from tests.check_anon_denied('whatsapp_apps',
    'org_id, meta_app_id', $$ tests.org_a(), '90000000007' $$, $$ status = 'x' $$);
select * from tests.check_anon_denied('message_queue',
    'org_id, phone_number, message_text', $$ tests.org_a(), '628111', 'x' $$, $$ status = 'failed' $$);
select * from tests.check_anon_denied('rate_limits',
    'identifier', $$ 'anon-x' $$, $$ request_count = 99 $$);
select * from tests.check_anon_denied('organizations',
    'name', $$ 'anon org' $$, $$ name = 'x' $$);
select * from tests.check_anon_denied('organization_members',
    'org_id, user_id, role', $$ tests.org_a(), tests.user_b1(), 'owner' $$, $$ role = 'owner' $$);

-- ---------------------------------------------------------------------------
-- 4. Denied writes left the other org's fixtures intact
-- ---------------------------------------------------------------------------
select tests.clear_authentication();

select results_eq(
    format($q$
        select count(*)::int from public.whatsapp_chats where org_id = %1$L and notes is null
        union all select count(*)::int from public.whatsapp_messages where org_id = %1$L and status is null
        union all select count(*)::int from public.orders where org_id = %1$L and venue is null
        union all select count(*)::int from public.proposals where org_id = %1$L and intro_note is null
        union all select count(*)::int from public.vendors where org_id = %1$L and notes is null
        union all select count(*)::int from public.documents where org_id = %1$L and metadata is null
        union all select count(*)::int from public.kb_sources where org_id = %1$L and content = 'isi'
        union all select count(*)::int from public.products where org_id = %1$L and description is null
        union all select count(*)::int from public.system_message where org_id = %1$L and description is null
        union all select count(*)::int from public.app_settings where org_id = %1$L and description is null
        union all select count(*)::int from public.labels where org_id = %1$L and color = 'slate'
        union all select count(*)::int from public.quick_replies where org_id = %1$L and content = 'isi'
        union all select count(*)::int from public.business_profiles where org_id = %1$L and website = ''
        union all select count(*)::int from public.whatsapp_integrations where org_id = %1$L and display_phone is null
        union all select count(*)::int from public.chat_labels where org_id = %1$L
        union all select count(*)::int from public.push_subscriptions where org_id = %1$L and user_agent is null
    $q$, tests.org_b()),
    $$ values (1),(1),(1),(1),(1),(1),(1),(1),(1),(1),(1),(1),(1),(1),(1),(1) $$,
    'every org B fixture is still there and unchanged after the cross-org attempts');

select * from finish();
rollback;
