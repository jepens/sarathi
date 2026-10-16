-- Tenant schema CONTRACT phase (migration 0062; tracker 1.4 / 1.5 / 1.7, audit
-- KUA-4 / KUA-5 / KEA-9):
--   1. org_id has no DEFAULT on the 13 tenant tables that used to default to
--      the seed org, so an insert without org_id fails loudly (23502) instead
--      of landing in Sailendra's tenant;
--   2. the global unique keys are gone, the org-scoped ones remain;
--   3. the platform keys are no longer in app_settings (platform_settings only).
-- Inserts run as postgres (RLS bypassed, like the service role), so the only
-- thing that can stop them is the NOT NULL on org_id; every other required
-- column is supplied and the exact error message is asserted.
begin;
select plan(37);

-- ---------------------------------------------------------------------------
-- 1. No org_id default; an insert without org_id is a NOT NULL violation
-- ---------------------------------------------------------------------------
select col_hasnt_default('public', t, 'org_id', format('%s.org_id has no default', t))
from unnest(array[
    'app_settings', 'chat_labels', 'documents', 'kb_sources', 'labels',
    'message_queue', 'orders', 'products', 'proposals', 'push_subscriptions',
    'quick_replies', 'system_message', 'vendors'
]) t;

select throws_ok(
    format('insert into public.%I (%s) values (%s)', t, cols, vals),
    '23502',
    format('null value in column "org_id" of relation "%s" violates not-null constraint', t),
    format('%s: an insert without org_id fails with a NOT NULL violation', t))
from (values
    ('app_settings',       'key, value',                         $$'k_tanpa_org', 'v'$$),
    ('chat_labels',        'phone_number, label_id',             $$'628100', gen_random_uuid()$$),
    ('documents',          'content',                            $$'isi'$$),
    ('kb_sources',         'title, content',                     $$'Judul', 'isi'$$),
    ('labels',             'name',                               $$'Label'$$),
    ('message_queue',      'phone_number, message_text',         $$'628100', 'halo'$$),
    ('orders',             'customer_phone',                     $$'628100'$$),
    ('products',           'name, price',                        $$'Produk', 1000$$),
    ('proposals',          'lead_phone, source, proposal_ref',   $$'628100', 'uploaded', 'REF-TANPA-ORG'$$),
    ('push_subscriptions', 'endpoint, p256dh, auth',             $$'https://push.example/tanpa-org', 'p', 'a'$$),
    ('quick_replies',      'shortcut, content',                  $$'/tanpaorg', 'isi'$$),
    ('system_message',     'name, content',                      $$'persona_tanpa_org', 'isi'$$),
    ('vendors',            'name, category',                     $$'Vendor', 'venue'$$)
) as v(t, cols, vals);

-- ---------------------------------------------------------------------------
-- 2. Global unique keys gone, org-scoped keys remain
-- ---------------------------------------------------------------------------
select hasnt_index('public', 'kb_sources', 'kb_sources_title_key',
                   'kb_sources: global unique (title) dropped');
select hasnt_index('public', 'system_message', 'system_message_name_key',
                   'system_message: global unique (name) dropped');
select hasnt_index('public', 'vendors', 'uq_vendors_chat_phone',
                   'vendors: global unique (chat_phone) dropped');
select hasnt_index('public', 'app_settings', 'app_settings_key_key',
                   'app_settings: global unique (key) dropped');

select has_index('public', 'kb_sources', 'kb_sources_org_title_key',
                 'kb_sources: unique (org_id, title) remains');
select has_index('public', 'system_message', 'system_message_org_name_key',
                 'system_message: unique (org_id, name) remains');
select has_index('public', 'vendors', 'uq_vendors_org_chat_phone',
                 'vendors: unique (org_id, chat_phone) remains');
select has_index('public', 'app_settings', 'app_settings_org_key_key',
                 'app_settings: unique (org_id, key) remains');

-- Every non-primary unique index on these four tables includes org_id.
select is_empty(
    $$ select i.indexrelid::regclass::text
       from pg_index i
       where i.indrelid in ('public.kb_sources'::regclass, 'public.system_message'::regclass,
                            'public.vendors'::regclass, 'public.app_settings'::regclass)
         and i.indisunique and not i.indisprimary
         and not exists (
             select 1 from pg_attribute a
             where a.attrelid = i.indrelid and a.attname = 'org_id'
               and a.attnum = any (i.indkey)) $$,
    'kb_sources / system_message / vendors / app_settings: no unique index without org_id');

-- ---------------------------------------------------------------------------
-- 3. Platform keys live in platform_settings only
-- ---------------------------------------------------------------------------
select is_empty(
    $$ select org_id, key from public.app_settings
       where key in ('default_org_id', 'whatsapp_verify_token', 'whatsapp_webhook_url') $$,
    'app_settings holds no platform key in any org');
select is((select value from public.platform_settings where key = 'default_org_id'),
          '5a11e024-0001-4000-8000-000000000001',
          'platform_settings still holds default_org_id (the seed org)');

select * from finish();
rollback;
