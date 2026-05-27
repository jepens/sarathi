-- Follow-up to 0006: the previous REVOKE on anon+authenticated was a no-op
-- because EXECUTE was actually granted to `PUBLIC` (which transitively grants
-- it to every role). Revoke from PUBLIC so only service_role can call it.

revoke execute on function public.verify_webhook_token(text) from public;
