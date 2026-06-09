-- Replace the permissive "auth full access" (USING true) policies with
-- org-scoped policies. Service-role bypasses RLS, so the webhook/queue paths
-- keep working; the authenticated dashboard now only sees rows of orgs the
-- logged-in user belongs to.
--
-- message_queue and rate_limits keep their existing "service_role only"
-- (USING false) policies — no authenticated/UI access, so no cross-tenant
-- exposure. message_queue still gets org_id (0027) for Fase 2 routing.

-- 1. Drop the old permissive policies (names verified via pg_policies).
drop policy if exists "auth full access" on public.whatsapp_chats;
drop policy if exists "auth full access" on public.whatsapp_messages;
drop policy if exists "auth full access" on public.documents;
drop policy if exists "auth full access" on public.kb_sources;
drop policy if exists "auth full access" on public.products;
drop policy if exists "auth full access" on public.orders;
drop policy if exists "Admins can do everything on orders" on public.orders;
drop policy if exists "auth full access" on public.proposals;
drop policy if exists "auth full access" on public.vendors;
drop policy if exists "auth full access" on public.system_message;
drop policy if exists "auth full access" on public.app_settings;
drop policy if exists "Allow authenticated users to read settings" on public.app_settings;
drop policy if exists "Allow authenticated users to update settings" on public.app_settings;

-- 2. Org-scoped "all" policy per tenant table (select/insert/update/delete).
do $$
declare t text;
begin
    foreach t in array array[
        'whatsapp_chats', 'whatsapp_messages', 'documents', 'kb_sources',
        'products', 'orders', 'proposals', 'vendors', 'system_message',
        'app_settings'
    ]
    loop
        execute format(
            'create policy "org members full access" on public.%I for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))',
            t
        );
    end loop;
end $$;
