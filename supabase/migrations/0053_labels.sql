-- Labels (fitur "list" ala WhatsApp Business). Colored tags the operator attaches
-- to chats/contacts to organize the inbox and filter by them.
--
-- NOTE: labels are purely a WhatsApp *Business App* feature — the Cloud API
-- exposes NO labels endpoint (confirmed against Meta docs; the API only has
-- conversation *billing categories* like MARKETING/AUTHENTICATION). So these
-- live entirely inside Sarathi and never sync to WhatsApp itself.

-- 1. Label definitions (org-global).
create table if not exists public.labels (
    id         uuid primary key default gen_random_uuid(),
    -- Single-tenant: defaults to the seed org (see lib/settings/org-context.ts),
    -- matching every peer tenant-scoped table (0025/0032/0039/0046/0051). The
    -- default lets the dashboard INSERT without supplying org_id.
    org_id     uuid not null default '5a11e024-0001-4000-8000-000000000001'
                   references public.organizations(id) on delete cascade,
    name       text not null,
    -- Palette KEY (not a hex) so the frontend fully controls light/dark
    -- rendering. Keep this CHECK in sync with LABEL_COLOR_KEYS in lib/labels.ts.
    color      text not null default 'slate'
                   check (color in (
                       'slate','red','orange','amber','yellow','green',
                       'emerald','teal','sky','blue','violet','pink'
                   )),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- One label name per org, case-insensitive (so "VIP" and "vip" can't collide).
create unique index if not exists labels_org_name_idx
    on public.labels (org_id, lower(name));

alter table public.labels enable row level security;

-- Single-tenant: any authenticated dashboard user manages labels
-- (mirrors push_subscriptions 0046 / quick_replies 0051).
do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'labels'
          and policyname = 'auth full access'
    ) then
        create policy "auth full access" on public.labels
            for all to authenticated using (true) with check (true);
    end if;
end $$;

-- 2. Chat <-> label assignments (many-to-many). A chat can carry several labels.
create table if not exists public.chat_labels (
    org_id       uuid not null default '5a11e024-0001-4000-8000-000000000001',
    phone_number text not null,
    label_id     uuid not null references public.labels(id) on delete cascade,
    created_at   timestamptz not null default now(),
    primary key (org_id, phone_number, label_id),
    -- Deleting a contact (0047 cascade) / chat removes its assignments too.
    constraint chat_labels_chat_fkey
        foreign key (org_id, phone_number)
        references public.whatsapp_chats(org_id, phone_number) on delete cascade
);

-- FK-covering + cascade-delete index for label_id. The composite PK's leading
-- (org_id, phone_number) already covers the chat FK.
create index if not exists chat_labels_label_idx on public.chat_labels (label_id);

alter table public.chat_labels enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'chat_labels'
          and policyname = 'auth full access'
    ) then
        create policy "auth full access" on public.chat_labels
            for all to authenticated using (true) with check (true);
    end if;
end $$;

-- 3. Seed 5 starter labels for the seed org (idempotent). Names mirror the
--    WhatsApp Business defaults, in Indonesian. on-conflict lets a re-run — or
--    an admin who already created one of these names — pass without error.
insert into public.labels (org_id, name, color)
values
    ('5a11e024-0001-4000-8000-000000000001', 'Baru',                'sky'),
    ('5a11e024-0001-4000-8000-000000000001', 'Pesanan Baru',        'violet'),
    ('5a11e024-0001-4000-8000-000000000001', 'Menunggu Pembayaran', 'amber'),
    ('5a11e024-0001-4000-8000-000000000001', 'Lunas',               'emerald'),
    ('5a11e024-0001-4000-8000-000000000001', 'Selesai',             'slate')
on conflict (org_id, lower(name)) do nothing;

-- 4. Realtime: so the inbox (ChatList chips + the chat-header picker) reflects
--    label edits/assignments live, like whatsapp_chats/_messages (0010). New
--    tables are NOT in the publication by default. Guarded so a re-run / fresh
--    apply doesn't error on an already-published table. RLS still applies —
--    only authenticated dashboard users receive the events.
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'labels'
    ) then
        alter publication supabase_realtime add table public.labels;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_labels'
    ) then
        alter publication supabase_realtime add table public.chat_labels;
    end if;
end $$;
