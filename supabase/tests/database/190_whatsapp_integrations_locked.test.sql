-- whatsapp_integrations is for the service role only (0069; Fase 2 task 2.1a,
-- audit KEA-16). It holds each tenant's WhatsApp access token and app secret
-- (moved to Vault in 2.1b), so neither a member nor anon may hold any table or
-- column privilege, and the only policy is the deny policy the other
-- service-role-only tables carry. Behaviour per role is checked in 010
-- (check_no_privilege for members of org A and B, check_anon_denied); this
-- file pins the catalog.
begin;
select plan(5);

select ok(
    not has_table_privilege('authenticated', 'public.whatsapp_integrations',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'authenticated holds no table privilege on whatsapp_integrations');
select ok(
    not has_any_column_privilege('authenticated', 'public.whatsapp_integrations',
        'SELECT, INSERT, UPDATE, REFERENCES'),
    'authenticated holds no column privilege on whatsapp_integrations');
select ok(
    not has_table_privilege('anon', 'public.whatsapp_integrations',
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'anon holds no table privilege on whatsapp_integrations');
select ok(
    has_table_privilege('service_role', 'public.whatsapp_integrations', 'SELECT')
    and has_table_privilege('service_role', 'public.whatsapp_integrations', 'INSERT')
    and has_table_privilege('service_role', 'public.whatsapp_integrations', 'UPDATE')
    and has_table_privilege('service_role', 'public.whatsapp_integrations', 'DELETE'),
    'the service role keeps select, insert, update and delete');
select is(
    (select string_agg(format('%s | %s | %s | %s | %s | %s',
                              policyname, permissive, cmd,
                              array_to_string(array(select unnest(roles) order by 1), ','),
                              coalesce(qual, '-'), coalesce(with_check, '-')), '; ')
       from pg_policies
      where schemaname = 'public' and tablename = 'whatsapp_integrations'),
    'service_role only | PERMISSIVE | ALL | anon,authenticated | false | false',
    'the only policy on whatsapp_integrations is the service-role-only deny policy');

select * from finish();
rollback;
