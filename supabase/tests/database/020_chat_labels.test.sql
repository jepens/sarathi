-- chat_labels: org scoping + the label-ownership rule from 0058 (tracker 1.2,
-- audit KUA-13 / KEA-3). The label_id FK is checked without RLS, so the
-- WITH CHECK must also require that the label belongs to the SAME org as the
-- assignment — otherwise a member could attach another tenant's label uuid.
begin;
select plan(13);

select tests.create_two_orgs();

insert into public.whatsapp_chats (org_id, phone_number) values
    (tests.org_a(), '628111'),
    (tests.org_b(), '628111');
insert into public.labels (id, org_id, name) values
    ('aaaaaaaa-1abe-4000-8000-00000000000a', tests.org_a(), 'Label A'),
    ('bbbbbbbb-1abe-4000-8000-00000000000b', tests.org_b(), 'Label B');
insert into public.chat_labels (org_id, phone_number, label_id) values
    (tests.org_b(), '628111', 'bbbbbbbb-1abe-4000-8000-00000000000b');

-- A label of the seed org (seeded by 0053), read while still postgres.
select id as seed_label from public.labels where org_id = tests.seed_org() order by name limit 1 \gset

select tests.authenticate_as(tests.user_a1());

select lives_ok(
    $$ insert into public.chat_labels (org_id, phone_number, label_id)
       values (tests.org_a(), '628111', 'aaaaaaaa-1abe-4000-8000-00000000000a') $$,
    'a member attaches their own org''s label to their own chat');
select throws_ok(
    $$ insert into public.chat_labels (org_id, phone_number, label_id)
       values (tests.org_a(), '628111', 'bbbbbbbb-1abe-4000-8000-00000000000b') $$,
    '42501', null,
    'a member cannot attach another org''s label to their own chat');
select throws_ok(
    format($$ insert into public.chat_labels (org_id, phone_number, label_id)
              values (tests.org_a(), '628111', %L) $$, :'seed_label'),
    '42501', null,
    'a member cannot attach a seed-org label to their own chat');
select throws_ok(
    $$ insert into public.chat_labels (org_id, phone_number, label_id)
       values (tests.org_b(), '628111', 'bbbbbbbb-1abe-4000-8000-00000000000b') $$,
    '42501', null,
    'a member cannot label another org''s chat');
select results_eq(
    $$ select label_id from public.chat_labels $$,
    array['aaaaaaaa-1abe-4000-8000-00000000000a'::uuid],
    'a member sees only their own org''s label assignments');
select throws_ok(
    $$ update public.chat_labels set label_id = 'bbbbbbbb-1abe-4000-8000-00000000000b'
       where org_id = tests.org_a() $$,
    '42501', null,
    'a member cannot swap in another org''s label on update');
select throws_ok(
    $$ update public.chat_labels set org_id = tests.org_b() where org_id = tests.org_a() $$,
    '42501', null,
    'a member cannot move an assignment into another org');
select is_empty(
    $$ update public.chat_labels set created_at = now() where org_id <> tests.org_a() returning 1 $$,
    'a member updates no other org''s assignment');
select is_empty(
    $$ delete from public.chat_labels where org_id <> tests.org_a() returning 1 $$,
    'a member deletes no other org''s assignment');
select isnt_empty(
    $$ delete from public.chat_labels where org_id = tests.org_a() returning 1 $$,
    'a member removes their own assignment');

select tests.authenticate_as(tests.user_b1());
select results_eq(
    $$ select org_id, label_id from public.chat_labels $$,
    $$ values ('bbbbbbbb-0000-4000-8000-00000000000b'::uuid, 'bbbbbbbb-1abe-4000-8000-00000000000b'::uuid) $$,
    'the other org sees only its own assignment');

select tests.authenticate_as_anon();
select is_empty($$ select 1 from public.chat_labels $$, 'anon reads no assignment');

select tests.clear_authentication();
select is(
    (select count(*)::int from public.chat_labels where org_id = tests.org_b()),
    1, 'org B''s assignment is intact');

select * from finish();
rollback;
