-- Fase 2a — per-tenant WhatsApp credentials. Each org stores its own Meta
-- WhatsApp Cloud API credentials so the webhook can route by phone_number_id and
-- send replies with the right token. Secrets (access_token, app_secret) are
-- protected by RLS now; Supabase Vault encryption is a later hardening step.

create table if not exists public.whatsapp_integrations (
    org_id          uuid primary key references public.organizations on delete cascade,
    phone_number_id text unique not null,
    access_token    text not null,
    app_secret      text,
    waba_id         text,
    display_phone   text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists whatsapp_integrations_phone_number_id_idx
    on public.whatsapp_integrations (phone_number_id);

alter table public.whatsapp_integrations enable row level security;
create policy "org members manage their whatsapp integration"
    on public.whatsapp_integrations for all to authenticated
    using (private.is_org_member(org_id))
    with check (private.is_org_member(org_id));
