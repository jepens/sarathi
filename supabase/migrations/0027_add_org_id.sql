-- Add org_id to every tenant-scoped table. NOT NULL DEFAULT <Sailendra org> so
-- existing rows backfill automatically (constant default = metadata-only in
-- PG11+) AND ongoing service-role inserts (which don't yet pass org_id) keep
-- working as single-tenant. The DEFAULT is dropped in Fase 2 once per-tenant
-- routing sets org_id explicitly.

do $$
declare
    t text;
    default_org constant text := '5a11e024-0001-4000-8000-000000000001';
begin
    foreach t in array array[
        'whatsapp_chats', 'whatsapp_messages', 'documents', 'kb_sources',
        'products', 'orders', 'proposals', 'vendors', 'system_message',
        'app_settings', 'message_queue'
    ]
    loop
        execute format(
            'alter table public.%I add column if not exists org_id uuid not null default %L references public.organizations',
            t, default_org
        );
        execute format(
            'create index if not exists %I on public.%I (org_id)',
            t || '_org_id_idx', t
        );
    end loop;
end $$;
