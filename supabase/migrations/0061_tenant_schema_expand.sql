-- Fase 1 — tenant schema, EXPAND phase (tracker 1.5, 1.6, 1.7, 1.8, 1.13;
-- audit KUA-5, KEA-14, KEA-9, KUA-6, KEA-25).
--
-- Adds the org-scoped keys, triggers and settings the multi-tenant code needs,
-- WITHOUT removing anything the code currently on main relies on. The global
-- unique keys (kb_sources_title_key, system_message_name_key,
-- uq_vendors_chat_phone, app_settings_key_key) and the platform rows in
-- app_settings stay until the contract migration, which runs only after the
-- code that targets the org-scoped keys is deployed everywhere.
--
--   1.5  per-org uniqueness
--        a. kb_sources (org_id, title): already exists (kb_sources_org_title_key,
--           0038) next to the global kb_sources_title_key; nothing to add.
--        b. system_message (org_id, name): new constraint
--           system_message_org_name_key.
--        c. vendors (org_id, chat_phone) where chat_phone is not null: new
--           unique index uq_vendors_org_chat_phone.
--        d. labels (org_id, id): new constraint labels_org_id_id_key, target of
--           the composite FK chat_labels (org_id, label_id) -> labels (org_id, id)
--           on delete cascade, which REPLACES chat_labels_label_id_fkey (exactly
--           one chat_labels -> labels relationship, so PostgREST embeds stay
--           unambiguous). Its covering index (org_id, label_id) replaces
--           chat_labels_label_idx (label_id). Production check before writing
--           this: 0 chat_labels rows whose label belongs to another org.
--        e. app_settings (org_id, key): new constraint app_settings_org_key_key
--           for tenant settings (lib/followup/digest.ts upserts on it).
--   1.6  org-aware triggers: sync_vendor_from_contact / cleanup_vendor_on_untag
--        only read and write vendors of the triggering chat's org (match on
--        (org_id, chat_phone)); ensure_single_active_system_message deactivates
--        only personas of the same org, and the partial unique index
--        system_message_one_active_per_org enforces one active persona per org.
--        While the global uq_vendors_chat_phone still exists, the vendor insert
--        uses ON CONFLICT DO NOTHING: tagging a number that is already a vendor
--        in ANOTHER org no longer aborts the contact update; that org-B vendor
--        row appears once the contract phase drops the global index.
--   1.7  public.platform_settings (service role only: RLS on, no policies,
--        anon/authenticated privileges revoked) with the platform keys copied
--        from app_settings. Platform keys = every key that configures the
--        single Sarathi deployment rather than a tenant:
--          default_org_id         org of the service-role paths (webhook, queue)
--          whatsapp_verify_token  Meta webhook verification secret (one app)
--          whatsapp_webhook_url   the deployment's webhook endpoint (one app)
--        (production holds exactly these 3 keys, all in the seed org). The
--        app_settings rows are NOT deleted: the code on main still reads them,
--        and the new code falls back to them when a platform row is missing.
--        verify_webhook_token() reads platform_settings first, same fallback.
--   1.13 match_documents / match_products fail closed: a NULL filter_org_id now
--        returns no rows (was: every org). Signature, the `default null` (CREATE
--        OR REPLACE cannot drop a parameter default) and the grants (anon
--        revoked in 0058) are unchanged; every caller (lib/ai/rag.ts,
--        app/api/search) already passes the org.
--
-- Deploy order: apply this migration to production BEFORE deploying the code of
-- this PR. It is backward compatible with the code on main: no column, key,
-- row or grant main uses is removed (the old label FK has no code dependency),
-- and main passes filter_org_id everywhere. The new code needs it first:
-- digest upserts on (org_id, key), settings read platform_settings.
--
-- Rollback (in this order, only after rolling the code back to main):
--   drop table public.platform_settings;
--   re-run verify_webhook_token from 00010, the two vendor functions from
--   0022 / 0024, ensure_single_active_system_message from 00010 (plus
--   `alter function ... set search_path = 'public'` from 0006) and the match_*
--   functions from 0030 (CREATE OR REPLACE keeps the grants);
--   drop index public.system_message_one_active_per_org,
--     public.uq_vendors_org_chat_phone, public.chat_labels_org_label_idx;
--   alter table public.chat_labels drop constraint chat_labels_org_label_fkey,
--     add constraint chat_labels_label_id_fkey foreign key (label_id)
--     references public.labels(id) on delete cascade;
--   create index chat_labels_label_idx on public.chat_labels (label_id);
--   alter table public.labels drop constraint labels_org_id_id_key;
--   alter table public.system_message drop constraint system_message_org_name_key;
--   alter table public.app_settings drop constraint app_settings_org_key_key;
-- No data is lost by the rollback (platform_settings is a copy).
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

-- ---------------------------------------------------------------------------
-- 1.5 per-org uniqueness + composite label FK
-- ---------------------------------------------------------------------------
alter table public.system_message
    add constraint system_message_org_name_key unique (org_id, name);

create unique index uq_vendors_org_chat_phone
    on public.vendors (org_id, chat_phone)
    where chat_phone is not null;

alter table public.app_settings
    add constraint app_settings_org_key_key unique (org_id, key);

alter table public.labels
    add constraint labels_org_id_id_key unique (org_id, id);

alter table public.chat_labels
    drop constraint chat_labels_label_id_fkey,
    add constraint chat_labels_org_label_fkey
        foreign key (org_id, label_id)
        references public.labels (org_id, id)
        on delete cascade;

-- FK-covering + cascade-delete index for the composite FK.
create index chat_labels_org_label_idx on public.chat_labels (org_id, label_id);
drop index public.chat_labels_label_idx;

-- ---------------------------------------------------------------------------
-- 1.6 org-aware triggers
-- ---------------------------------------------------------------------------
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
        -- Expand phase only: the global uq_vendors_chat_phone may still hold
        -- this number for ANOTHER org. Skip instead of failing the contact
        -- update; never touch that org's row.
        on conflict do nothing;
    end if;
    return new;
end;
$function$;

create or replace function public.cleanup_vendor_on_untag()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
    delete from public.vendors
    where org_id = new.org_id
      and chat_phone = new.phone_number
      and verified = false;
    return new;
end;
$function$;

create or replace function public.ensure_single_active_system_message()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
    if new.is_active = true then
        -- Deactivate the other active persona of the SAME org only.
        update public.system_message
        set is_active = false
        where org_id = new.org_id
          and id <> new.id
          and is_active = true;
    end if;
    return new;
end;
$function$;

-- One active persona per org (production: 1 org with personas, 1 active).
create unique index system_message_one_active_per_org
    on public.system_message (org_id)
    where is_active = true;

-- ---------------------------------------------------------------------------
-- 1.7 platform settings (service role only)
-- ---------------------------------------------------------------------------
create table public.platform_settings (
    key        text primary key,
    value      text not null,
    updated_at timestamptz not null default now()
);

comment on table public.platform_settings is
    'Deployment-level configuration (default org, webhook verify token/URL). '
    'Service role only: RLS on without policies. Tenant settings stay in app_settings (org_id, key).';

alter table public.platform_settings enable row level security;
revoke all on table public.platform_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.platform_settings to service_role;

create trigger trg_platform_settings_updated_at
    before update on public.platform_settings
    for each row execute function public.set_updated_at();

insert into public.platform_settings (key, value, updated_at)
select s.key, s.value, coalesce(s.updated_at, now())
from public.app_settings s
where s.key in ('default_org_id', 'whatsapp_verify_token', 'whatsapp_webhook_url')
  and s.org_id = '5a11e024-0001-4000-8000-000000000001'::uuid
on conflict (key) do nothing;

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

    -- Rollout fallback: the legacy row of the seed org (removed in the
    -- contract phase together with the app_settings platform rows).
    if stored_token is null or stored_token = '' then
        select value into stored_token
        from public.app_settings
        where key = 'whatsapp_verify_token'
          and org_id = '5a11e024-0001-4000-8000-000000000001'::uuid;
    end if;

    -- Fail closed: no (or an empty) token never verifies.
    if stored_token is null or stored_token = '' then
        return false;
    end if;

    return stored_token = input_token;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 1.13 match_* fail closed for a NULL org
-- ---------------------------------------------------------------------------
create or replace function public.match_documents(
    query_embedding vector,
    match_threshold double precision,
    match_count integer,
    filter_org_id uuid default null
)
returns table(id uuid, content text, metadata jsonb, similarity double precision)
language plpgsql
set search_path to 'public', 'extensions'
as $function$
begin
    -- filter_org_id is mandatory in practice: NULL matches no org_id, so a
    -- caller that forgets the org gets nothing instead of every tenant's KB.
    return query
    select
        documents.id,
        documents.content,
        documents.metadata,
        1 - (documents.embedding <=> query_embedding) as similarity
    from documents
    where documents.org_id = filter_org_id
      and 1 - (documents.embedding <=> query_embedding) > match_threshold
    order by documents.embedding <=> query_embedding
    limit match_count;
end;
$function$;

create or replace function public.match_products(
    query_embedding vector,
    match_threshold double precision,
    match_count integer,
    filter_org_id uuid default null
)
returns table(id uuid, name text, description text, price numeric, stock integer, metadata jsonb, similarity double precision)
language plpgsql
set search_path to 'public', 'extensions'
as $function$
begin
    -- See match_documents: NULL filter_org_id returns no rows.
    return query
    select
        products.id,
        products.name,
        products.description,
        products.price,
        products.stock,
        products.metadata,
        1 - (products.embedding <=> query_embedding) as similarity
    from products
    where products.org_id = filter_org_id
      and 1 - (products.embedding <=> query_embedding) > match_threshold
    order by products.embedding <=> query_embedding
    limit match_count;
end;
$function$;
