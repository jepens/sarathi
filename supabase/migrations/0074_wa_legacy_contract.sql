-- Fase 2 — task 2.2d (PR-3): contract wa_legacy_contract. Design:
-- docs/FASE2_DESIGN.md ("wa_legacy_contract (2.2d)"); owner decisions D31, D32.
--
-- Why. Since PR #70 (2.2d, deployed 2026-11-26) nothing reads the platform
-- webhook verify token or URL: the bare /api/webhook/whatsapp route is gone
-- (404), every Meta app has its own webhook URL and verify token (0073, the
-- token only as sha256), and Settings no longer shows a URL. What is left is
-- dead: verify_webhook_token() (service role only since 0006/0007) and the two
-- platform_settings rows the old route and the old Settings card read. The
-- verify token row is a secret at rest with no reader.
--   Production 2026-11-26 (read-only, keys only): platform_settings holds
--   default_org_id, whatsapp_verify_token and whatsapp_webhook_url. The keys
--   legacy_webhook_key and wa_creds_source of the design were never created
--   (D32: no switch).
--
-- What:
--   * drop public.verify_webhook_token(text);
--   * delete the platform_settings rows whatsapp_verify_token and
--     whatsapp_webhook_url (default_org_id stays: getDefaultOrgId);
--   * the table comment no longer names the webhook keys.
--
-- Compatible with the deployed code (PR #70, ad3f0b6): nothing calls the
-- function or reads the two rows. A build older than #70 needs both, so this
-- is applied only with the owner's approval (D1) and only after
--   * 7 days with the #70 build live and no legacy traffic (the design; the
--     build went live 2026-11-26, so 2026-12-03 at the earliest), and
--   * the D31 rotation and the removal of the WhatsApp credential env vars
--     (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
--     WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_VERIFY_TOKEN) from Easypanel,
--     after which a build older than #70 cannot run anyway.
--     WHATSAPP_OTHER_NUMBER_EVENTS and WHATSAPP_DEBOUNCE_SECONDS stay.
-- Rollback: re-create the function from 0062 with its grants (EXECUTE for
-- service_role only, revoked from public, anon and authenticated: 0006/0007).
-- The two rows are not needed by any live build.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

drop function public.verify_webhook_token(text);

delete from public.platform_settings
where key in ('whatsapp_verify_token', 'whatsapp_webhook_url');

comment on table public.platform_settings is
    'Deployment-level configuration (the default org). '
    'Service role only: RLS on without policies. Tenant settings stay in app_settings (org_id, key).';
