-- Lead intake: remember the lead's instansi/perusahaan (company). Captured by
-- the AI during the opening "kenalan" flow (name → company) via save_lead_info,
-- or set manually. Feeds the Pipeline/Contacts UI and the Portal handoff brief.
--
-- Additive & nullable — existing rows survive untouched. Idempotent
-- (`if not exists`) so the file can be re-applied safely.

alter table if exists public.whatsapp_chats
    add column if not exists company text;

comment on column public.whatsapp_chats.company is
    'Instansi/perusahaan lead — ditangkap AI saat kenalan (save_lead_info) atau diisi manual. Ikut ke brief proposal Portal (Phase 2 handoff).';
