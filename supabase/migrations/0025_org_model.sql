-- Fase 1a — multi-tenancy foundation: organizations + membership + RLS helper.
-- 1 user = 1 org for now; org is derived from the logged-in user's membership.

create table if not exists public.organizations (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    slug        text unique,
    created_at  timestamptz not null default now()
);

do $$ begin
    create type public.org_role as enum ('owner', 'admin', 'staff');
exception when duplicate_object then null;
end $$;

create table if not exists public.organization_members (
    org_id     uuid not null references public.organizations on delete cascade,
    user_id    uuid not null references auth.users on delete cascade,
    role       public.org_role not null default 'owner',
    created_at timestamptz not null default now(),
    primary key (org_id, user_id)
);
create index if not exists organization_members_user_id_idx
    on public.organization_members (user_id);

-- SECURITY DEFINER membership check. Two reasons (Supabase RLS guide):
--  1. lets the policy on organization_members reference membership without
--     recursing into its own RLS;
--  2. faster than an inline correlated subquery in every table policy.
create or replace function public.is_org_member(check_org uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
    select exists (
        select 1
        from public.organization_members m
        where m.org_id = check_org
          and m.user_id = (select auth.uid())
    );
$$;
revoke all on function public.is_org_member(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated;

alter table public.organizations enable row level security;
create policy "members read their org" on public.organizations
    for select to authenticated using (public.is_org_member(id));

alter table public.organization_members enable row level security;
-- uses (select auth.uid()) directly so it does not recurse via is_org_member.
create policy "read own memberships" on public.organization_members
    for select to authenticated using (user_id = (select auth.uid()));
