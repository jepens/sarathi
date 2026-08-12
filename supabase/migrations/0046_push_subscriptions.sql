-- Web Push subscriptions (Tier 2 notifications).
--
-- Tier 1 (realtime + in-app chime/desktop notification) only works while a
-- dashboard tab is open. Tier 2 pushes a notification from the server whenever a
-- customer message arrives, so the operator is alerted even with the app closed —
-- exactly like WhatsApp Web's background notifications.
--
-- One row per browser/device that opted in. The browser mints a unique push
-- `endpoint` per device, so that is the natural conflict key: re-subscribing the
-- same device UPDATEs its keys instead of piling up duplicates. The webhook fans
-- a push out to every row in the org on each inbound message (via the service-role
-- key, which bypasses RLS), and prunes rows the push service reports as gone
-- (HTTP 404/410).

create table if not exists public.push_subscriptions (
    id          uuid primary key default gen_random_uuid(),
    -- Single-tenant: defaults to the seed org (see lib/settings/org-context.ts).
    -- FK + on delete cascade matches every peer tenant-scoped table (0025/0032/0039).
    org_id      uuid not null default '5a11e024-0001-4000-8000-000000000001'
                    references public.organizations(id) on delete cascade,
    endpoint    text not null unique,
    p256dh      text not null,
    auth        text not null,
    user_agent  text,
    created_at  timestamptz not null default now(),
    last_used_at timestamptz
);

create index if not exists push_subscriptions_org_idx
    on public.push_subscriptions (org_id);

alter table public.push_subscriptions enable row level security;

-- Single-tenant: any authenticated dashboard user manages push subscriptions.
-- The webhook writes/prunes through the service-role client, which bypasses RLS.
do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'push_subscriptions'
          and policyname = 'auth full access'
    ) then
        create policy "auth full access" on public.push_subscriptions
            for all to authenticated using (true) with check (true);
    end if;
end $$;
