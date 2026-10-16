-- Baseline: schema objects that production got OUTSIDE supabase/migrations
-- (audit KUA-1, tracker 1.1).
--
-- Why this file exists: the first production tables were created by hand in the
-- SQL editor from the top-level database/*.sql scripts, before the project kept
-- migration files. Later migrations (0002+) ALTER those tables, so replaying
-- supabase/migrations on an empty database (`supabase db reset`, CI, staging,
-- disaster recovery) failed. This file recreates them exactly as they stood
-- right before production's first recorded migration (20260526101729
-- enable_rls_and_policies, replayed by 00011_enable_rls_and_policies.sql).
--
-- Ordering: version 00010 runs after 0000_init_schema (which creates
-- documents, products and match_*) and before 0002. Its position relative to
-- 0001_storage_policy depends on the CLI version (2.121.0, pinned in CI,
-- sorts by version string: 0001 < 00010; some CLI versions sort by file
-- name: 00010_ < 0001_). Both orders are valid: 0001 only adds storage policies that do not
-- reference anything created here. See supabase/README.md "Naming".
--
-- Sources (cross-checked 2026-10-16 against the production catalog with
-- supabase/fingerprint/schema_fingerprint.sql — see supabase/README.md):
--   database/whatsapp_monitoring.sql   whatsapp_chats, whatsapp_messages
--   database/add_contact_name.sql      whatsapp_chats.contact_name
--   database/orders_schema.sql         orders
--   database/app_settings_schema.sql   app_settings, verify_webhook_token()
--   database/system_message_schema.sql system_message + triggers
--   database/scalability-schema.sql    message_queue, rate_limits, cleanup_*()
--   database/add_product_type.sql      products.type
--   database/optimize_search.sql       pg_trgm + search indexes
--   (dashboard)                        the 'documents' storage bucket
--
-- NOT copied from database/: data seeds (default webhook URL / verify token,
-- the "Sahabat UMKM" system message, env-to-settings copies). They were never
-- schema, and the verify-token default was removed on purpose (Fase 0).
--
-- Shapes are the HISTORICAL ones that later migrations expect, e.g.:
--   * whatsapp_chats keyed by phone_number alone (0034 swaps the PK to
--     (org_id, phone_number) and drops the FKs created here by name);
--   * pg_trgm installed in public, like vector from 0000 (0008 moves both to
--     the extensions schema);
--   * permissive legacy policies (dropped by 0005 / 0028);
--   * functions without a pinned search_path (0006 pins it);
--   * verify_webhook_token executable by anon/authenticated (0006/0007 revoke);
--   * the documents bucket public (0037 makes it private).
--
-- Production already has all of this: this file is for fresh databases only
-- and must never be applied to production (production history has no entry for
-- it, and it is deliberately not idempotent — it fails loudly on a database
-- that already has these tables).

-- ---------------------------------------------------------------------------
-- Extensions (database/optimize_search.sql). vector comes from 0000.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm with schema public;

-- ---------------------------------------------------------------------------
-- WhatsApp conversations (database/whatsapp_monitoring.sql, add_contact_name.sql)
-- ---------------------------------------------------------------------------
create table public.whatsapp_chats (
    phone_number    text primary key,
    last_message    text,
    last_message_at timestamptz default now(),
    unread_count    integer default 0,
    created_at      timestamptz default now(),
    updated_at      timestamptz default now(),
    contact_name    text
);

create table public.whatsapp_messages (
    id           uuid primary key default gen_random_uuid(),
    phone_number text not null references public.whatsapp_chats(phone_number),
    role         text not null check (role in ('user', 'assistant', 'system')),
    content      text not null,
    created_at   timestamptz default now(),
    metadata     jsonb default '{}'::jsonb
);

create index idx_whatsapp_messages_phone on public.whatsapp_messages(phone_number);
create index idx_whatsapp_messages_created_at on public.whatsapp_messages(created_at);
create index whatsapp_messages_phone_created_at_idx
    on public.whatsapp_messages (phone_number, created_at desc);

alter table public.whatsapp_chats enable row level security;
alter table public.whatsapp_messages enable row level security;

-- Legacy anon-readable policies; dropped by 0005_drop_public_whatsapp_policies.
create policy "Allow public access to whatsapp_chats" on public.whatsapp_chats
    for all using (true);
create policy "Allow public access to whatsapp_messages" on public.whatsapp_messages
    for all using (true);

-- ---------------------------------------------------------------------------
-- Orders (database/orders_schema.sql, optimize_search.sql)
-- ---------------------------------------------------------------------------
create table public.orders (
    id             uuid primary key default gen_random_uuid(),
    customer_name  text,
    customer_phone text references public.whatsapp_chats(phone_number),
    items          jsonb not null default '[]'::jsonb,
    total_amount   numeric default 0,
    status         text default 'pending',
    delivery_info  text,
    order_type     text default 'product',
    created_at     timestamptz default now(),
    updated_at     timestamptz default now()
);

alter table public.orders enable row level security;

-- Legacy policy; dropped by 0028_org_rls_policies.
create policy "Admins can do everything on orders" on public.orders
    for all to authenticated using (true) with check (true);

create index idx_orders_customer_phone on public.orders(customer_phone);
create index idx_orders_created_at on public.orders(created_at desc);
-- Duplicate of idx_orders_customer_phone; dropped by 0036.
create index orders_customer_phone_idx on public.orders (customer_phone);

-- ---------------------------------------------------------------------------
-- Catalog extras on top of 0000's products table (database/add_product_type.sql,
-- database/optimize_search.sql)
-- ---------------------------------------------------------------------------
alter table public.products
    add column type text default 'product' check (type in ('product', 'service'));

comment on column public.products.type is
    'Product type: product (physical goods with stock) or service (unlimited availability)';

create index products_name_trgm_idx on public.products using gin (name gin_trgm_ops);
create index products_type_idx on public.products (type);

-- ---------------------------------------------------------------------------
-- App settings (database/app_settings_schema.sql)
-- ---------------------------------------------------------------------------
create table public.app_settings (
    id          uuid primary key default gen_random_uuid(),
    key         text unique not null,
    value       text not null,
    description text,
    created_at  timestamptz default now(),
    updated_at  timestamptz default now()
);

create index idx_app_settings_key on public.app_settings(key);

alter table public.app_settings enable row level security;

-- Legacy policies; dropped by 0028_org_rls_policies.
create policy "Allow authenticated users to read settings" on public.app_settings
    for select to authenticated using (true);
create policy "Allow authenticated users to update settings" on public.app_settings
    for update to authenticated using (true) with check (true);

create function public.update_app_settings_updated_at()
returns trigger
language plpgsql
as $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

create trigger app_settings_updated_at
    before update on public.app_settings
    for each row
    execute function public.update_app_settings_updated_at();

-- Webhook verify-token check. Its EXECUTE grants are narrowed to service_role
-- by 0006 + 0007.
create function public.verify_webhook_token(input_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
DECLARE
    stored_token TEXT;
BEGIN
    SELECT value INTO stored_token
    FROM app_settings
    WHERE key = 'whatsapp_verify_token';

    -- If no token stored, default to false (or handle as needed)
    IF stored_token IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN stored_token = input_token;
END;
$$;

grant execute on function public.verify_webhook_token(text) to anon;
grant execute on function public.verify_webhook_token(text) to authenticated;
grant execute on function public.verify_webhook_token(text) to service_role;

-- ---------------------------------------------------------------------------
-- AI persona (database/system_message_schema.sql)
-- ---------------------------------------------------------------------------
create table public.system_message (
    id          uuid primary key default gen_random_uuid(),
    name        varchar(100) not null unique,
    content     text not null,
    is_active   boolean default false,
    description text,
    created_at  timestamptz default now(),
    updated_at  timestamptz default now()
);

create index idx_system_message_active on public.system_message(is_active) where is_active = true;

create function public.ensure_single_active_system_message()
returns trigger
language plpgsql
as $$
BEGIN
  IF NEW.is_active = true THEN
    -- Deactivate all other system messages
    UPDATE system_message
    SET is_active = false
    WHERE id != NEW.id AND is_active = true;
  END IF;
  RETURN NEW;
END;
$$;

create trigger trigger_single_active_system_message
    before insert or update on public.system_message
    for each row
    when (new.is_active = true)
    execute function public.ensure_single_active_system_message();

create function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

create trigger update_system_message_updated_at
    before update on public.system_message
    for each row
    execute function public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Inbound queue + rate limiter (database/scalability-schema.sql)
-- ---------------------------------------------------------------------------
create table public.message_queue (
    id            uuid primary key default gen_random_uuid(),
    phone_number  text not null,
    message_text  text not null,
    status        text not null default 'pending',
    retries       integer not null default 0,
    max_retries   integer not null default 3,
    error_message text,
    created_at    timestamptz default now(),
    updated_at    timestamptz default now(),
    processed_at  timestamptz
);

create index idx_message_queue_status on public.message_queue(status);
create index idx_message_queue_created_at on public.message_queue(created_at);

create table public.rate_limits (
    id            uuid primary key default gen_random_uuid(),
    identifier    text not null unique,
    request_count integer not null default 1,
    window_start  timestamptz default now(),
    created_at    timestamptz default now(),
    updated_at    timestamptz default now()
);

create index idx_rate_limits_identifier on public.rate_limits(identifier);

create function public.cleanup_old_rate_limits()
returns void
language plpgsql
as $$
BEGIN
    DELETE FROM rate_limits
    WHERE window_start < NOW() - INTERVAL '5 minutes';
END;
$$;

create function public.cleanup_old_queue_entries()
returns void
language plpgsql
as $$
BEGIN
    DELETE FROM message_queue
    WHERE status IN ('completed', 'failed')
    AND processed_at < NOW() - INTERVAL '24 hours';
END;
$$;

-- ---------------------------------------------------------------------------
-- Storage: the KB 'documents' bucket was created in the dashboard (public at
-- first; 0001 added public policies, 0037 made it private, 0038 scoped it per
-- org). 'proposals' and 'chat-media' are created by 00040 / 0048.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('documents', 'documents', true)
on conflict (id) do nothing;
