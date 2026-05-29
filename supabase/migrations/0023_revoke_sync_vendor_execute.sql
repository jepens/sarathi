-- Follow-up to 0022: sync_vendor_from_contact() is a SECURITY DEFINER trigger
-- function. By default EXECUTE is granted to PUBLIC, which exposes it as a
-- PostgREST RPC (/rest/v1/rpc/sync_vendor_from_contact) callable by anon /
-- authenticated — flagged by the security advisor. Trigger functions are
-- invoked by the trigger mechanism (as the table owner), NOT via the caller's
-- EXECUTE grant, so revoking from PUBLIC is safe and the triggers keep working.
-- Same fix pattern as 0007 (revoke_verify_webhook_token_public).

revoke execute on function public.sync_vendor_from_contact() from public;
revoke execute on function public.sync_vendor_from_contact() from anon;
revoke execute on function public.sync_vendor_from_contact() from authenticated;
