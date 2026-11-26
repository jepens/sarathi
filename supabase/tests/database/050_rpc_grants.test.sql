-- RPC surface: who may EXECUTE what, and that the callable SECURITY DEFINER /
-- vector-search functions stay inside the caller's org (tracker 1.2, audit
-- KUA-13 / KEA-5 / KEA-25).
begin;
select plan(66);

select tests.create_two_orgs();

-- ---------------------------------------------------------------------------
-- 1. EXECUTE privileges (effective, i.e. including grants to PUBLIC)
-- ---------------------------------------------------------------------------
select is(has_function_privilege(r, 'public.reserve_meeting_slot(uuid, text, text, timestamptz, text, timestamptz, timestamptz, integer, integer, integer)', 'execute'),
          r = 'service_role',
          format('reserve_meeting_slot: executable by %s = %s', r, r = 'service_role'))
from unnest(array['anon', 'authenticated', 'service_role']) r;

select is(has_function_privilege(r, 'public.delete_contact_cascade(uuid, text)', 'execute'),
          r <> 'anon',
          format('delete_contact_cascade: executable by %s = %s', r, r <> 'anon'))
from unnest(array['anon', 'authenticated']) r;

select is(has_function_privilege(r, f, 'execute'),
          r <> 'anon',
          format('%s: executable by %s = %s', f, r, r <> 'anon'))
from unnest(array['public.match_documents(extensions.vector, double precision, integer, uuid)',
                  'public.match_products(extensions.vector, double precision, integer, uuid)']) f,
     unnest(array['anon', 'authenticated']) r;

select is(has_function_privilege(r, 'private.is_org_member(uuid)', 'execute'),
          r <> 'anon',
          format('private.is_org_member: executable by %s = %s', r, r <> 'anon'))
from unnest(array['anon', 'authenticated']) r;

-- Push device registration (0065; behaviour in 160_push_device_owner).
select is(has_function_privilege(r, 'public.register_push_subscription(uuid, text, text, text, text)', 'execute'),
          r <> 'anon',
          format('register_push_subscription: executable by %s = %s', r, r <> 'anon'))
from unnest(array['anon', 'authenticated']) r;

-- Org Realtime bus (0064; behaviour in 150_realtime_org_broadcast): the topic
-- helper is evaluated by the realtime.messages policy as authenticated; the
-- broadcaster only fires from its triggers (as its owner).
select is(has_function_privilege(r, 'private.realtime_topic_org_id(text)', 'execute'),
          r <> 'anon',
          format('private.realtime_topic_org_id: executable by %s = %s', r, r <> 'anon'))
from unnest(array['anon', 'authenticated']) r;

select ok(not has_function_privilege(r, 'private.broadcast_org_changes()', 'execute'),
          format('private.broadcast_org_changes: not executable by %s', r))
from unnest(array['anon', 'authenticated', 'service_role']) r;

-- Server-only functions: never callable through the API roles. The webhook's
-- inbound ingest and its work queue (0072; behaviour in 220_wa_inbound_ingest)
-- are for the service role only.
select ok(not has_function_privilege(r, f, 'execute'),
          format('%s: not executable by %s', f, r))
from unnest(array['public.bump_unread(uuid, text)',
                  'public.claim_queue_jobs(integer, integer, integer)',
                  'public.handle_new_user()',
                  'public.sync_vendor_from_contact()',
                  'public.cleanup_vendor_on_untag()',
                  'public.wa_ingest_inbound(uuid, text, text, text, timestamptz, text, text, text, text, '
                      || 'text, text, text, jsonb, boolean, text, integer, boolean, text, integer, text, jsonb)',
                  'public.wa_apply_statuses(uuid, jsonb)',
                  'public.claim_inbound_work(integer, integer, uuid)',
                  'public.cleanup_old_inbound_work()',
                  -- per-client Meta apps and their Vault secrets (0073;
                  -- behaviour in 230_wa_apps_vault)
                  'public.wa_provision_app(uuid, text, text, text, text)',
                  'public.wa_provision_number(uuid, text, text, text)',
                  'public.wa_rotate_secret(uuid, text, text)',
                  'public.wa_webhook_app(text)',
                  'public.wa_org_send_credentials(uuid)',
                  'public.wa_offboard_org(uuid)']) f,
     unnest(array['anon', 'authenticated']) r;

-- ---------------------------------------------------------------------------
-- 2. Fixtures: same customer phone in both orgs, KB rows with embeddings
-- ---------------------------------------------------------------------------
insert into public.whatsapp_chats (org_id, phone_number) values
    (tests.org_a(), '628111'),
    (tests.org_b(), '628111');
insert into public.whatsapp_messages (org_id, phone_number, role, content) values
    (tests.org_a(), '628111', 'user', 'pesan A'),
    (tests.org_b(), '628111', 'user', 'pesan B');
insert into public.documents (org_id, content, embedding) values
    (tests.org_a(), 'dokumen A', array_fill(0.1::real, array[1536])::extensions.vector),
    (tests.org_b(), 'dokumen B', array_fill(0.1::real, array[1536])::extensions.vector);
insert into public.products (org_id, name, price, embedding) values
    (tests.org_a(), 'produk A', 1000, array_fill(0.1::real, array[1536])::extensions.vector),
    (tests.org_b(), 'produk B', 1000, array_fill(0.1::real, array[1536])::extensions.vector);

-- ---------------------------------------------------------------------------
-- 3. As a member of org A
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.user_a1());

select throws_ok(
    $$ select public.reserve_meeting_slot(tests.org_a(), '628111', 'x', now(), null,
           now(), now() + interval '1 day', 4, 30, 15) $$,
    '42501', null,
    'reserve_meeting_slot: an authenticated user cannot book (service role only)');

select throws_ok(
    $$ select public.delete_contact_cascade(tests.org_b(), '628111') $$,
    '42501', 'not authorized to delete contacts for this org',
    'delete_contact_cascade: a member cannot delete another org''s contact');
select is(
    public.delete_contact_cascade(tests.org_a(), '628111'),
    '{"deleted": true}'::jsonb,
    'delete_contact_cascade: a member deletes their own org''s contact');

-- SECURITY INVOKER + RLS, and fail closed per org since 0061 (a NULL
-- filter_org_id returns nothing; see 120_match_fail_closed).
select results_eq(
    $$ select content from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 10, tests.org_a()) $$,
    array['dokumen A'],
    'match_documents (filter = own org): a member only retrieves their own org''s documents');
select is_empty(
    $$ select 1 from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 10, tests.org_b()) $$,
    'match_documents (filter = other org): nothing comes back');
select results_eq(
    $$ select name from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 10, tests.org_a()) $$,
    array['produk A'],
    'match_products (filter = own org): a member only retrieves their own org''s products');
select is_empty(
    $$ select 1 from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 10, tests.org_b()) $$,
    'match_products (filter = other org): nothing comes back');

select is(private.is_org_member(tests.org_a()), true, 'is_org_member: true for the caller''s org');
select is(private.is_org_member(tests.org_b()), false, 'is_org_member: false for another org');
select is(private.is_org_member(tests.seed_org()), false, 'is_org_member: false for the seed org');

-- ---------------------------------------------------------------------------
-- 4. As anon
-- ---------------------------------------------------------------------------
select tests.authenticate_as_anon();

select throws_ok(
    $$ select public.delete_contact_cascade(tests.org_b(), '628111') $$,
    '42501', null,
    'delete_contact_cascade: anon cannot call it');
select throws_ok(
    $$ select * from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 10) $$,
    '42501', null,
    'match_documents: anon cannot call it');
select throws_ok(
    $$ select * from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 10) $$,
    '42501', null,
    'match_products: anon cannot call it');
select throws_ok(
    $$ select public.reserve_meeting_slot(tests.org_a(), '628111', 'x', now(), null,
           now(), now() + interval '1 day', 4, 30, 15) $$,
    '42501', null,
    'reserve_meeting_slot: anon cannot call it');

-- ---------------------------------------------------------------------------
-- 5. As the service role (webhook / queue worker)
-- ---------------------------------------------------------------------------
select tests.authenticate_as_service_role();

select is(
    (public.reserve_meeting_slot(tests.org_b(), '628111', 'Pelanggan B',
        date_trunc('day', now()) + interval '2 days 10 hours', null,
        date_trunc('day', now()) + interval '2 days', date_trunc('day', now()) + interval '3 days',
        4, 30, 15) ->> 'created')::boolean,
    true,
    'reserve_meeting_slot: the service role books a meeting');

-- ---------------------------------------------------------------------------
-- 6. State after the denied calls
-- ---------------------------------------------------------------------------
select tests.clear_authentication();

select is(
    (select count(*)::int from public.whatsapp_chats where org_id = tests.org_b()),
    1, 'org B''s contact survived the cross-org delete attempt');
select is(
    (select count(*)::int from public.whatsapp_messages where org_id = tests.org_b()),
    1, 'org B''s chat history survived the cross-org delete attempt');
select is(
    (select count(*)::int from public.whatsapp_chats where org_id = tests.org_a()),
    0, 'org A''s own contact was deleted');

select * from finish();
rollback;
