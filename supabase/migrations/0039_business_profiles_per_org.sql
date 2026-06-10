-- Fase A: per-tenant AI identity. Move the BusinessProfile (company name,
-- assistant name, hand-off contact, etc.) out of the global app_settings
-- key-value table (which has a UNIQUE(key) — no room for per-org rows) into a
-- dedicated per-org table. Each org gets exactly one row; RLS isolates it.
create table public.business_profiles (
  org_id           uuid primary key references public.organizations(id) on delete cascade,
  business_name    text not null default '',
  assistant_name   text not null default '',
  specialties      text not null default '',
  established_year text not null default '',
  service_areas    text not null default '',
  handoff_name     text not null default '',
  handoff_phone    text not null default '',
  business_email   text not null default '',
  website          text not null default '',
  updated_at       timestamptz not null default now()
);

alter table public.business_profiles enable row level security;

-- Org members manage their own profile. Service-role (webhook/queue) bypasses
-- RLS and reads by org_id directly.
create policy "business_profiles org members" on public.business_profiles
  for all to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

-- Seed Sailendra's row with the current values (app_settings business.* was
-- empty, so the DEFAULT_BUSINESS_PROFILE constants are authoritative). Keeps the
-- live bot's persona byte-identical after the code switches to this table.
insert into public.business_profiles
  (org_id, business_name, assistant_name, specialties, established_year,
   service_areas, handoff_name, handoff_phone, business_email, website)
values
  ('5a11e024-0001-4000-8000-000000000001',
   'Sailendra Organizer', 'Nindra',
   'Team Building, Capacity Building, dan Company Gathering', '2016',
   'Jabodetabek, Bandung, Jogja, Bali, kota lain di Indonesia, dan internasional atas permintaan',
   'MJ (Mang Jajang)', '+62 812-8195-8110', 'info@sailendra.co.id', 'sailendra.co.id')
on conflict (org_id) do nothing;
