-- Security hardening (advisor findings):
--   1. Pin search_path on 7 functions that didn't have it set (lint
--      function_search_path_mutable). Without a pinned search_path, a
--      malicious user who can create a schema in a higher precedence
--      position could shadow `documents`/`products`/etc. and influence
--      function output. Pinning to 'public' matches what
--      verify_webhook_token already does.
--   2. Revoke EXECUTE on verify_webhook_token from anon + authenticated.
--      It's a SECURITY DEFINER function that reads app_settings — should
--      only be callable server-side. Webhook GET handler now uses
--      service_role via lib/supabase/service.ts.

alter function public.cleanup_old_queue_entries() set search_path = 'public';
alter function public.cleanup_old_rate_limits() set search_path = 'public';
alter function public.ensure_single_active_system_message() set search_path = 'public';
alter function public.match_documents(vector, double precision, integer) set search_path = 'public';
alter function public.match_products(vector, double precision, integer) set search_path = 'public';
alter function public.update_app_settings_updated_at() set search_path = 'public';
alter function public.update_updated_at_column() set search_path = 'public';

revoke execute on function public.verify_webhook_token(text) from anon;
revoke execute on function public.verify_webhook_token(text) from authenticated;
-- service_role keeps EXECUTE (default grant + explicit GRANT in original schema).
