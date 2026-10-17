-- Fase 2 — task 2.1a (audit KEA-16): whatsapp_integrations is for the service
-- role only. Design: docs/FASE2_DESIGN.md (task 2.1a); owner decision D6.
--
-- Why (KEA-16). The table holds a tenant's WhatsApp access token and app
-- secret (plaintext until 2.1b moves them to Supabase Vault). Since 0032 every
-- member of an org may create, read, change and delete its org's row (policy
-- "org members manage their whatsapp integration", FOR ALL, and the
-- authenticated role holds every table privilege). So a member could read a
-- token, or claim any phone_number_id before Fase 2 routes inbound webhooks by
-- number (2.2). Nothing in the app reads or writes the table since the
-- single-tenant revert (cb709bc): the webhook and every send path use the env
-- credentials of the default org until 2.2. Production 2026-10-17
-- (read-only): 0 rows, authenticated = rawdDxt, anon = none (0063), 1 policy.
--
-- What:
--   * refuse to run if the table has a row (someone used it through the API:
--     review who and why before locking it);
--   * drop the member policy of 0032;
--   * revoke every table privilege from anon and authenticated, so the
--     privilege check refuses a member before RLS is consulted;
--   * add the deny policy the other service-role-only tables carry
--     (message_queue, rate_limits): a later grant alone does not reopen it.
-- The service role keeps its privileges and bypasses RLS.
--
-- Compatible with the deployed code (nothing touches the table), so it is
-- applied right after the owner's review (D1); no deploy is needed.
-- Rollback (only while the table holds no secret): drop the deny policy,
--   grant select, insert, update, delete, truncate, references, trigger
--     on public.whatsapp_integrations to authenticated;
-- and re-create the 0032 policy.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

do $$
begin
    if exists (select 1 from public.whatsapp_integrations) then
        raise exception '0069 refused: whatsapp_integrations has rows; review who wrote them before locking the table';
    end if;
end $$;

drop policy if exists "org members manage their whatsapp integration" on public.whatsapp_integrations;

revoke all on table public.whatsapp_integrations from anon, authenticated;

create policy "service_role only" on public.whatsapp_integrations
    as permissive for all to anon, authenticated
    using (false) with check (false);
