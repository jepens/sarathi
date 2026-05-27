-- M3.2 — Proposals audit table.
-- One row per proposal version (generated or uploaded). Lets us track which
-- intro_note the admin used, when it was sent, to which email, plus the
-- Resend message id for traceability.

create table if not exists public.proposals (
    id              uuid primary key default gen_random_uuid(),
    lead_phone      text not null references public.whatsapp_chats(phone_number) on delete cascade,

    -- Discriminator. 'generated' = rendered from ProposalDocument template on demand
    -- (file_path is null, regenerate any time). 'uploaded' = admin uploaded a custom
    -- PDF to Supabase Storage (file_path is set).
    source          text not null check (source in ('generated', 'uploaded')),
    file_path       text,                  -- storage path for source='uploaded'

    intro_note      text,                  -- email body intro the admin typed
    proposal_ref    text not null,         -- human-readable ref e.g. SLDR-20260527-1128

    sent_at         timestamptz,           -- null = draft (uploaded but not sent yet)
    sent_to_email   text,                  -- email used at send time (snapshot)
    email_provider_id text,                -- Resend message id, when sent
    skipped_reason  text,                  -- why email send was skipped (no API key, etc.)

    created_at      timestamptz not null default now(),
    created_by      uuid                   -- auth.users.id of admin who uploaded/sent
);

create index if not exists idx_proposals_lead_phone
    on public.proposals(lead_phone);

create index if not exists idx_proposals_created_at
    on public.proposals(created_at desc);

-- Enforce that 'uploaded' source rows have a file_path and 'generated' rows don't.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'proposals_source_filepath_check') then
        alter table public.proposals
            add constraint proposals_source_filepath_check
            check (
                (source = 'uploaded' and file_path is not null) or
                (source = 'generated' and file_path is null)
            );
    end if;
end $$;

-- RLS — authenticated dashboard users have full access. Customer-facing
-- access (e.g. share link with klien) is intentionally NOT enabled here;
-- if needed later, add a separate signed-URL flow.
alter table public.proposals enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'proposals' and policyname = 'auth full access'
    ) then
        create policy "auth full access" on public.proposals
            for all to authenticated
            using (true)
            with check (true);
    end if;
end $$;
