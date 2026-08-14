-- Quick replies (balasan cepat / canned responses). Admin-authored snippets the
-- operator inserts into the chat composer via a ⚡ picker or a "/shortcut"
-- autocomplete. Distinct from Meta message templates (those re-engage outside the
-- 24h window and need Meta approval) — these are plain local text inserted into a
-- normal message, so they only work inside the 24h window like any free-form reply.
--
-- Content may contain {nama} / {perusahaan} / {event} placeholders that the
-- dashboard fills from the open chat's contact_name / company / event_interest at
-- insert time (see lib/quick-replies.ts).

create table if not exists public.quick_replies (
    id         uuid primary key default gen_random_uuid(),
    -- Single-tenant: defaults to the seed org (see lib/settings/org-context.ts),
    -- matching every peer tenant-scoped table (0025/0032/0039/0046). The default
    -- lets the dashboard INSERT without supplying org_id.
    org_id     uuid not null default '5a11e024-0001-4000-8000-000000000001'
                   references public.organizations(id) on delete cascade,
    shortcut   text not null,
    content    text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- One shortcut per org, case-insensitive so "/Harga" and "/harga" can't collide
-- (the "/" autocomplete matches case-insensitively).
create unique index if not exists quick_replies_org_shortcut_idx
    on public.quick_replies (org_id, lower(shortcut));

create index if not exists quick_replies_org_idx on public.quick_replies (org_id);

alter table public.quick_replies enable row level security;

-- Single-tenant: any authenticated dashboard user manages quick replies
-- (mirrors push_subscriptions 0046).
do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'quick_replies'
          and policyname = 'auth full access'
    ) then
        create policy "auth full access" on public.quick_replies
            for all to authenticated using (true) with check (true);
    end if;
end $$;
