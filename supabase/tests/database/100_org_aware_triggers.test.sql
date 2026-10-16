-- Org-aware vendor + persona triggers (migrations 0061 / 0062; tracker 1.6 / 1.8,
-- audit KEA-14 / KUA-6): tagging/untagging the same phone number in two orgs
-- never reads or writes the other org's vendor row, and activating a persona
-- only deactivates personas of the same org (one active persona per org).
begin;
select plan(16);

select tests.create_two_orgs();

insert into public.whatsapp_chats (org_id, phone_number, contact_name) values
    (tests.org_a(), '628111', 'Kontak A'),
    (tests.org_b(), '628111', 'Kontak B');

-- ---------------------------------------------------------------------------
-- 1. sync_vendor_from_contact
-- ---------------------------------------------------------------------------
-- Org B already has an unverified vendor row for this number.
insert into public.vendors (org_id, name, category, chat_phone, verified)
values (tests.org_b(), 'Vendor milik B', 'venue', '628111', false);

-- Tag the contact in org A as a member of org A (RLS path of the dashboard).
select tests.authenticate_as(tests.user_a1());
select lives_ok(
    $$ update public.whatsapp_chats set contact_type = 'vendor'
       where org_id = tests.org_a() and phone_number = '628111' $$,
    'org A: tagging a contact as vendor succeeds although org B has a vendor with that number');
select tests.clear_authentication();

-- Global uq_vendors_chat_phone is gone (0062): org A gets ITS OWN row and
-- org B's row is never touched.
select results_eq(
    $$ select org_id, name from public.vendors where chat_phone = '628111' order by name $$,
    $$ values (tests.org_a(), 'Kontak A'), (tests.org_b(), 'Vendor milik B') $$,
    'tagging in org A creates org A''s vendor row (org_id of the chat, name of the contact)');
select is((select contact_type from public.whatsapp_chats where org_id = tests.org_a() and phone_number = '628111'),
          'vendor', 'org A''s contact update was kept');

-- Re-tagging org A's contact (row exists) creates nothing new.
update public.whatsapp_chats set contact_type = 'vendor', contact_name = 'Kontak A2'
where org_id = tests.org_a() and phone_number = '628111';
select is((select count(*)::int from public.vendors where chat_phone = '628111'), 2,
          're-tagging in org A does not duplicate org A''s vendor row');

update public.whatsapp_chats set contact_type = 'lead'
where org_id = tests.org_a() and phone_number = '628111';
select results_eq(
    $$ select org_id from public.vendors where chat_phone = '628111' $$,
    $$ values (tests.org_b()) $$,
    'untagging in org A deletes only org A''s unverified vendor, not org B''s');

update public.whatsapp_chats set contact_type = 'vendor'
where org_id = tests.org_a() and phone_number = '628111';
select is((select count(*)::int from public.vendors where org_id = tests.org_a() and chat_phone = '628111'), 1,
          're-tagging in org A recreates org A''s row');

-- Org B tags (B already has a row → nothing new), then untags its contact.
update public.whatsapp_chats set contact_type = 'vendor'
where org_id = tests.org_b() and phone_number = '628111';
update public.whatsapp_chats set contact_type = 'lead'
where org_id = tests.org_b() and phone_number = '628111';
select results_eq(
    $$ select org_id from public.vendors where chat_phone = '628111' $$,
    $$ values (tests.org_a()) $$,
    'untagging in org B deletes only org B''s unverified vendor');
update public.whatsapp_chats set contact_type = 'vendor'
where org_id = tests.org_b() and phone_number = '628111';
select is((select count(*)::int from public.vendors where chat_phone = '628111'), 2,
          're-tagging in org B recreates only org B''s row');

-- A new contact inserted as vendor directly (insert trigger) gets its org.
insert into public.whatsapp_chats (org_id, phone_number, contact_type)
values (tests.org_b(), '628222', 'vendor');
select is((select org_id from public.vendors where chat_phone = '628222'), tests.org_b(),
          'insert trigger: the vendor row belongs to the chat''s org (not the seed default)');

-- ---------------------------------------------------------------------------
-- 2. ensure_single_active_system_message + one active persona per org
-- ---------------------------------------------------------------------------
-- Baseline of another org's active persona (the seed org), rolled back anyway.
insert into public.system_message (org_id, name, content, is_active)
select tests.seed_org(), 'persona_seed_test', 's', true
where not exists (select 1 from public.system_message where org_id = tests.seed_org() and is_active);
select string_agg(id::text, ',' order by id) as seed_active
from public.system_message where org_id = tests.seed_org() and is_active \gset

insert into public.system_message (org_id, name, content, is_active) values
    (tests.org_a(), 'persona_a1', 'a1', true),
    (tests.org_b(), 'persona_b1', 'b1', true);

insert into public.system_message (org_id, name, content, is_active)
values (tests.org_a(), 'persona_a2', 'a2', true);
select results_eq(
    $$ select name from public.system_message where org_id in (tests.org_a(), tests.org_b()) and is_active order by name $$,
    array['persona_a2', 'persona_b1']::varchar[],
    'activating a persona in org A deactivates only org A''s previous persona');

update public.system_message set is_active = true
where org_id = tests.org_a() and name = 'persona_a1';
select results_eq(
    $$ select name from public.system_message where org_id in (tests.org_a(), tests.org_b()) and is_active order by name $$,
    array['persona_a1', 'persona_b1']::varchar[],
    're-activating via UPDATE also stays within the org');

select is((select string_agg(id::text, ',' order by id) from public.system_message
           where org_id = tests.seed_org() and is_active),
          :'seed_active',
          'the seed org''s active persona is not touched by activations in org A');

-- As a member of org A (RLS path): their activation is confined to org A too.
select tests.authenticate_as(tests.user_a1());
select lives_ok(
    $$ update public.system_message set is_active = true where org_id = tests.org_a() and name = 'persona_a2' $$,
    'a member activates another persona of their own org');
select tests.clear_authentication();
select results_eq(
    $$ select name from public.system_message where org_id in (tests.org_a(), tests.org_b()) and is_active order by name $$,
    array['persona_a2', 'persona_b1']::varchar[],
    'member activation: org B''s active persona is untouched');

-- The partial unique index is the hard guarantee (e.g. trigger bypassed).
alter table public.system_message disable trigger trigger_single_active_system_message;
select throws_ok(
    $$ insert into public.system_message (org_id, name, content, is_active)
       values (tests.org_a(), 'persona_a3', 'a3', true) $$,
    '23505', null,
    'a second active persona in one org is rejected even without the trigger');
select lives_ok(
    $$ insert into public.system_message (org_id, name, content, is_active)
       values (tests.org_b(), 'persona_b2', 'b2', false) $$,
    'inactive personas are unrestricted');
alter table public.system_message enable trigger trigger_single_active_system_message;

select * from finish();
rollback;
