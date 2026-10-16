-- Fase 1 — tenant schema, CONTRACT phase (tracker 1.4, 1.5, 1.7; audit KUA-4,
-- KUA-5, KEA-9). Removes what the expand migration 0061 had to keep for the
-- code on main.
--
--   1.4  org_id fail-loud: drop the column DEFAULT (= the seed org
--        5a11e024-0001-4000-8000-000000000001) on the 13 tables that still had
--        it: app_settings, chat_labels, documents, kb_sources, labels,
--        message_queue, orders, products, proposals, push_subscriptions,
--        quick_replies, system_message, vendors. org_id stays NOT NULL, so an
--        insert that forgets the org now fails with 23502 instead of silently
--        landing in Sailendra's tenant. Every write path in the code of this
--        PR sets org_id explicitly (requireOrgContext / the service-role org
--        being processed), and the three SQL functions that insert into these
--        tables do too: sync_vendor_from_contact (new.org_id),
--        reserve_meeting_slot (p_org), handle_new_user (no insert into them).
--   1.5  drop the global unique keys superseded by the org-scoped ones of
--        0038 / 0061:
--          kb_sources_title_key   -> kb_sources_org_title_key   (org_id, title)
--          system_message_name_key-> system_message_org_name_key(org_id, name)
--          uq_vendors_chat_phone  -> uq_vendors_org_chat_phone  (org_id, chat_phone)
--          app_settings_key_key   -> app_settings_org_key_key   (org_id, key)
--        No FK references any of them. push_subscriptions_endpoint_key is NOT
--        touched (out of scope, the push upsert still targets it).
--        sync_vendor_from_contact now names its conflict target
--        (org_id, chat_phone): the NOT EXISTS check already skips an existing
--        row of the same org, the ON CONFLICT only absorbs a concurrent tag.
--   1.7  the platform keys (default_org_id, whatsapp_verify_token,
--        whatsapp_webhook_url) leave app_settings: a missing platform row is
--        first copied from the seed org's row (no-op when 0061 already did),
--        then the app_settings rows of these keys are deleted in EVERY org
--        (a tenant row with a platform key name is never a platform setting).
--        verify_webhook_token() reads platform_settings only (the seed-org
--        fallback of 0061 is gone; the code fallback was removed in the same
--        PR, lib/settings/platform-settings.ts).
--
-- Deploy order: apply 0061 first, then deploy the code of this PR, then apply
-- this migration AFTER that code runs on every instance. The code on main is
-- NOT compatible with it (inserts without org_id, digest upsert on 'key').
--
-- Rollback (only together with rolling the code back to main, schema first):
--   alter table public.<each of the 13 tables> alter column org_id
--     set default '5a11e024-0001-4000-8000-000000000001'::uuid;
--   alter table public.kb_sources add constraint kb_sources_title_key unique (title);
--   alter table public.system_message add constraint system_message_name_key unique (name);
--   create unique index uq_vendors_chat_phone on public.vendors (chat_phone)
--     where chat_phone is not null;
--   alter table public.app_settings add constraint app_settings_key_key unique (key);
--   (the global keys fail if two orgs now share a title/name/phone/key: resolve
--   those rows first)
--   insert into public.app_settings (org_id, key, value, updated_at)
--   select '5a11e024-0001-4000-8000-000000000001'::uuid, key, value, updated_at
--   from public.platform_settings
--   on conflict (org_id, key) do update set value = excluded.value;
--   re-run verify_webhook_token and sync_vendor_from_contact from 0061.
-- platform_settings keeps the values, so no data is lost by the delete below.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

-- ---------------------------------------------------------------------------
-- 1.4 org_id has no default: an insert must name its org
-- ---------------------------------------------------------------------------
alter table public.app_settings       alter column org_id drop default;
alter table public.chat_labels        alter column org_id drop default;
alter table public.documents          alter column org_id drop default;
alter table public.kb_sources         alter column org_id drop default;
alter table public.labels             alter column org_id drop default;
alter table public.message_queue      alter column org_id drop default;
alter table public.orders             alter column org_id drop default;
alter table public.products           alter column org_id drop default;
alter table public.proposals          alter column org_id drop default;
alter table public.push_subscriptions alter column org_id drop default;
alter table public.quick_replies      alter column org_id drop default;
alter table public.system_message     alter column org_id drop default;
alter table public.vendors            alter column org_id drop default;

-- ---------------------------------------------------------------------------
-- 1.5 global unique keys superseded by the org-scoped ones
-- ---------------------------------------------------------------------------
alter table public.kb_sources     drop constraint kb_sources_title_key;
alter table public.system_message drop constraint system_message_name_key;
alter table public.app_settings   drop constraint app_settings_key_key;
drop index public.uq_vendors_chat_phone;

create or replace function public.sync_vendor_from_contact()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
    if not exists (
        select 1 from public.vendors v
        where v.org_id = new.org_id
          and v.chat_phone = new.phone_number
    ) then
        insert into public.vendors (org_id, name, category, phone, email, notes, chat_phone, verified)
        values (
            new.org_id,
            coalesce(new.contact_name, new.phone_number),
            case
                when new.vendor_category in (
                    'catering','venue','transport','entertainment',
                    'photography','decoration','mc','other'
                ) then new.vendor_category
                else 'other'
            end,
            new.phone_number,
            new.email,
            new.vendor_offering,
            new.phone_number,
            false
        )
        -- A concurrent tag of the same contact in the same org won the race.
        on conflict (org_id, chat_phone) where chat_phone is not null do nothing;
    end if;
    return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 1.7 platform keys live in platform_settings only
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, updated_at)
select s.key, s.value, coalesce(s.updated_at, now())
from public.app_settings s
where s.key in ('default_org_id', 'whatsapp_verify_token', 'whatsapp_webhook_url')
  and s.org_id = '5a11e024-0001-4000-8000-000000000001'::uuid
on conflict (key) do nothing;

delete from public.app_settings
where key in ('default_org_id', 'whatsapp_verify_token', 'whatsapp_webhook_url');

create or replace function public.verify_webhook_token(input_token text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    stored_token text;
begin
    select value into stored_token
    from public.platform_settings
    where key = 'whatsapp_verify_token';

    -- Fail closed: no (or an empty) token never verifies.
    if stored_token is null or stored_token = '' then
        return false;
    end if;

    return stored_token = input_token;
end;
$function$;
