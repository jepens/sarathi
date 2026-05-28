-- Canonical, editable source text for knowledge-base documents authored in
-- the dashboard editor. The `documents` table holds derived, chunked +
-- embedded text (lossy due to overlap, not round-trippable), so we keep the
-- editable master here. On save the API re-chunks + re-embeds into
-- `documents` (delete-by-source then insert), keyed by title.

create table if not exists public.kb_sources (
    id          uuid primary key default gen_random_uuid(),
    title       text not null unique,
    content     text not null,
    updated_at  timestamptz not null default now(),
    created_at  timestamptz not null default now(),
    created_by  uuid
);

alter table public.kb_sources enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'kb_sources' and policyname = 'auth full access'
    ) then
        create policy "auth full access" on public.kb_sources
            for all to authenticated using (true) with check (true);
    end if;
end $$;

-- Reuse the shared set_updated_at() trigger (created in 0004_vendors_table).
drop trigger if exists trg_kb_sources_updated_at on public.kb_sources;
create trigger trg_kb_sources_updated_at
    before update on public.kb_sources
    for each row execute function public.set_updated_at();
