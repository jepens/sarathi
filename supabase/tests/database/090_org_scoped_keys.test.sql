-- Org-scoped unique keys + composite label FK (migration 0061; tracker 1.5,
-- audit KUA-5). Expand phase: the org-scoped keys exist; the global keys are
-- dropped by the contract migration, so "same value in two orgs" is asserted
-- with the global key removed inside this (rolled back) transaction.
begin;
select plan(17);

select tests.create_two_orgs();

-- ---------------------------------------------------------------------------
-- 1. The org-scoped keys exist (catalog)
-- ---------------------------------------------------------------------------
select is(pg_get_indexdef('public.kb_sources_org_title_key'::regclass),
          'CREATE UNIQUE INDEX kb_sources_org_title_key ON public.kb_sources USING btree (org_id, title)',
          'kb_sources: unique (org_id, title)');
select is(pg_get_indexdef('public.system_message_org_name_key'::regclass),
          'CREATE UNIQUE INDEX system_message_org_name_key ON public.system_message USING btree (org_id, name)',
          'system_message: unique (org_id, name)');
select is(pg_get_indexdef('public.uq_vendors_org_chat_phone'::regclass),
          'CREATE UNIQUE INDEX uq_vendors_org_chat_phone ON public.vendors USING btree (org_id, chat_phone) WHERE (chat_phone IS NOT NULL)',
          'vendors: unique (org_id, chat_phone) where chat_phone is not null');
select is(pg_get_indexdef('public.app_settings_org_key_key'::regclass),
          'CREATE UNIQUE INDEX app_settings_org_key_key ON public.app_settings USING btree (org_id, key)',
          'app_settings: unique (org_id, key)');
select is((select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.chat_labels'::regclass and contype = 'f'
             and confrelid = 'public.labels'::regclass),
          'FOREIGN KEY (org_id, label_id) REFERENCES labels(org_id, id) ON DELETE CASCADE',
          'chat_labels has exactly one FK to labels: (org_id, label_id) -> labels(org_id, id)');

-- ---------------------------------------------------------------------------
-- 2. Duplicates within ONE org are rejected by the org-scoped key
--    (the global key is dropped first so the org-scoped one is what fires)
-- ---------------------------------------------------------------------------
alter table public.kb_sources drop constraint kb_sources_title_key;
alter table public.system_message drop constraint system_message_name_key;
drop index public.uq_vendors_chat_phone;
alter table public.app_settings drop constraint app_settings_key_key;

insert into public.whatsapp_chats (org_id, phone_number) values
    (tests.org_a(), '628111'),
    (tests.org_b(), '628111');

select lives_ok(
    $$ insert into public.kb_sources (org_id, title, content) values
           (tests.org_a(), 'FAQ', 'a'), (tests.org_b(), 'FAQ', 'b') $$,
    'kb_sources: the same title is allowed in two orgs');
select throws_ok(
    $$ insert into public.kb_sources (org_id, title, content) values (tests.org_a(), 'FAQ', 'a2') $$,
    '23505', null,
    'kb_sources: a duplicate title within one org is rejected');

select lives_ok(
    $$ insert into public.system_message (org_id, name, content) values
           (tests.org_a(), 'default', 'a'), (tests.org_b(), 'default', 'b') $$,
    'system_message: the same name is allowed in two orgs');
select throws_ok(
    $$ insert into public.system_message (org_id, name, content) values (tests.org_a(), 'default', 'a2') $$,
    '23505', null,
    'system_message: a duplicate name within one org is rejected');

select lives_ok(
    $$ insert into public.vendors (org_id, name, category, chat_phone) values
           (tests.org_a(), 'Vendor A', 'venue', '628111'),
           (tests.org_b(), 'Vendor B', 'venue', '628111') $$,
    'vendors: the same chat_phone is allowed in two orgs');
select throws_ok(
    $$ insert into public.vendors (org_id, name, category, chat_phone)
       values (tests.org_a(), 'Vendor A2', 'venue', '628111') $$,
    '23505', null,
    'vendors: a duplicate chat_phone within one org is rejected');
select lives_ok(
    $$ insert into public.vendors (org_id, name, category) values
           (tests.org_a(), 'Tanpa nomor 1', 'venue'), (tests.org_a(), 'Tanpa nomor 2', 'venue') $$,
    'vendors: any number of vendors without chat_phone per org');

select lives_ok(
    $$ insert into public.app_settings (org_id, key, value) values
           (tests.org_a(), 'tenant_key', 'a'), (tests.org_b(), 'tenant_key', 'b') $$,
    'app_settings: the same key is allowed in two orgs');
select throws_ok(
    $$ insert into public.app_settings (org_id, key, value) values (tests.org_a(), 'tenant_key', 'a2') $$,
    '23505', null,
    'app_settings: a duplicate key within one org is rejected');

-- ---------------------------------------------------------------------------
-- 3. Composite label FK (checked without RLS, i.e. also for the service role)
-- ---------------------------------------------------------------------------
insert into public.labels (id, org_id, name) values
    ('aaaaaaaa-1abe-4000-8000-00000000000a', tests.org_a(), 'Label A'),
    ('bbbbbbbb-1abe-4000-8000-00000000000b', tests.org_b(), 'Label B');

select throws_ok(
    $$ insert into public.chat_labels (org_id, phone_number, label_id)
       values (tests.org_a(), '628111', 'bbbbbbbb-1abe-4000-8000-00000000000b') $$,
    '23503', null,
    'chat_labels: a label of another org is rejected by the FK (as postgres, RLS bypassed)');
select lives_ok(
    $$ insert into public.chat_labels (org_id, phone_number, label_id)
       values (tests.org_a(), '628111', 'aaaaaaaa-1abe-4000-8000-00000000000a') $$,
    'chat_labels: a label of the same org is accepted');

delete from public.labels where id = 'aaaaaaaa-1abe-4000-8000-00000000000a';
select is((select count(*)::int from public.chat_labels where org_id = tests.org_a()), 0,
          'chat_labels: deleting the label cascades to its assignments');

select * from finish();
rollback;
