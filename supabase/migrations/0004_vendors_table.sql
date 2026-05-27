-- M4 — Vendor management (contact-only scope).
-- Stores EO vendor contacts (catering, venue, transport, photography, etc.)
-- so admin can keep a central directory. No price list, no booking link yet —
-- that comes later when we wire vendor↔orders relationships.

create table if not exists public.vendors (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,            -- vendor / company name
    category        text not null,            -- see CHECK below
    contact_person  text,                     -- PIC name
    phone           text,                     -- main contact phone (free-form; not normalized)
    email           text,                     -- contact email
    address         text,                     -- physical address
    notes           text,                     -- free-form notes (price hints, past collab, etc.)
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    created_by      uuid                      -- auth.users.id of admin who added
);

-- Vendor categories typical for EO ops in Indonesia. 'other' covers anything
-- not in the canonical list (e.g. florist, sound system, generator rental).
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'vendors_category_check') then
        alter table public.vendors
            add constraint vendors_category_check
            check (category in (
                'catering',
                'venue',
                'transport',
                'entertainment',
                'photography',
                'decoration',
                'mc',
                'other'
            ));
    end if;
end $$;

create index if not exists idx_vendors_category on public.vendors(category);
create index if not exists idx_vendors_name on public.vendors(name);
create index if not exists idx_vendors_created_at on public.vendors(created_at desc);

-- updated_at trigger. Used only by vendors for now; if we add more tables
-- needing this we can move set_updated_at to its own migration.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_vendors_updated_at on public.vendors;
create trigger trg_vendors_updated_at
    before update on public.vendors
    for each row execute function public.set_updated_at();

-- RLS — authenticated dashboard users get full access. Same pattern as
-- proposals + whatsapp_chats CRM extension. No public role.
alter table public.vendors enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'vendors' and policyname = 'auth full access'
    ) then
        create policy "auth full access" on public.vendors
            for all to authenticated
            using (true)
            with check (true);
    end if;
end $$;
