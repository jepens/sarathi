-- Fase 2 — task 2.1b: each tenant's own Meta app, with its WhatsApp secrets in
-- Supabase Vault. Owner decision D6 (2026-10-17): one Meta app per client.
-- Design: docs/FASE2_DESIGN.md ("wa_apps_vault (2.1b)"), trimmed for the pilot
-- (owner rule 2026-11-12: no overengineering; tracker log 2026-11-20).
--
-- What:
--   * whatsapp_apps: one row per client Meta app. The app secret and the System
--     User token live in Vault (only their ids are stored here); the verify
--     token is kept as a sha256 only; webhook_key is the routing id of the
--     app's own webhook URL (/api/webhook/whatsapp/<key>, task 2.2c). It is not
--     a secret: trust comes from the signature (FASE2_DESIGN invariant I1).
--   * whatsapp_integrations (0032, locked to the service role by 0069, still
--     empty): reshaped to one row per number of an app. The plaintext
--     access_token / app_secret columns are dropped.
--   * One app and one number per org for the pilot (UNIQUE org_id on both):
--     chats and the queue are keyed by org, so a second number would send its
--     replies from the first one (design review, minor).
--   * The org foreign keys become RESTRICT: an org with an app is offboarded
--     with wa_offboard_org first, which deletes its Vault secrets too (design
--     review: CASCADE would orphan them).
--   * Service-role-only RPCs to provision, rotate, read for the webhook, read
--     for sending, and offboard. Rotation updates the same Vault row, so secret
--     names never collide (design review). A rotated app secret is used at once;
--     webhooks signed with the old one fail (401) until Meta's retry delivers
--     them under the new one, so nothing is lost.
--
-- Left out on purpose (add when a tenant needs it): a staged second app secret
-- and webhook-key grace period, token/quality health columns (the send itself
-- reports a bad token), a per-app Graph version (lib/whatsapp/graph.ts is
-- global), a stored 2FA PIN, and the unrouted-id table (2.2c raises an ops
-- event instead).
--
-- Secrets never reach chat or logs: they are typed by a human into the
-- provisioning script (2.1c), and production verification reads non-secret
-- columns only. Nobody runs wa_webhook_app / wa_org_send_credentials or reads
-- vault.decrypted_secrets by hand in production.
--
-- Compatible with the deployed code: nothing reads or writes these tables
-- until 2.2c (lib/whatsapp/credentials.ts serves the default org from env).
-- Applied after the owner's review (D1); no deploy is needed.
-- Rollback (only while whatsapp_apps is empty): drop the six functions, drop
-- table whatsapp_apps, and restore whatsapp_integrations as in 0032 + 0069.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

do $$
begin
    if exists (select 1 from public.whatsapp_integrations) then
        raise exception '0073 refused: whatsapp_integrations has rows; review them before the reshape';
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- whatsapp_apps
-- ---------------------------------------------------------------------------
create table public.whatsapp_apps (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references public.organizations(id) on delete restrict,
    meta_app_id text not null check (meta_app_id ~ '^[0-9]{5,25}$'),
    webhook_key text not null check (webhook_key ~ '^[A-Za-z0-9_-]{32}$'),
    app_secret_id uuid not null,
    access_token_secret_id uuid not null,
    verify_token_sha256 bytea not null check (octet_length(verify_token_sha256) = 32),
    status text not null default 'active' check (status in ('active', 'suspended')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint whatsapp_apps_org_id_key unique (org_id),
    constraint whatsapp_apps_meta_app_id_key unique (meta_app_id),
    constraint whatsapp_apps_webhook_key_key unique (webhook_key),
    constraint whatsapp_apps_id_org_key unique (id, org_id)
);

alter table public.whatsapp_apps enable row level security;
revoke all on table public.whatsapp_apps from anon, authenticated;
create policy "service_role only" on public.whatsapp_apps
    as permissive for all to anon, authenticated
    using (false) with check (false);

create trigger trg_whatsapp_apps_updated_at
    before update on public.whatsapp_apps
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- whatsapp_integrations: one row per number of an app
-- ---------------------------------------------------------------------------
alter table public.whatsapp_integrations
    drop constraint whatsapp_integrations_pkey,
    drop constraint whatsapp_integrations_org_id_fkey;

-- duplicates the unique key whatsapp_integrations_phone_number_id_key
drop index public.whatsapp_integrations_phone_number_id_idx;

alter table public.whatsapp_integrations
    drop column access_token,
    drop column app_secret,
    add column id uuid not null default gen_random_uuid(),
    add column app_id uuid not null,
    add column status text not null default 'active' check (status in ('active', 'paused')),
    alter column waba_id set not null,
    add constraint whatsapp_integrations_pkey primary key (id),
    add constraint whatsapp_integrations_org_id_key unique (org_id),
    add constraint whatsapp_integrations_org_id_fkey
        foreign key (org_id) references public.organizations(id) on delete restrict,
    add constraint whatsapp_integrations_app_fkey
        foreign key (app_id, org_id) references public.whatsapp_apps(id, org_id) on delete restrict,
    add constraint whatsapp_integrations_ids_check
        check (phone_number_id ~ '^[0-9]{5,25}$' and waba_id ~ '^[0-9]{5,25}$');

create trigger trg_whatsapp_integrations_updated_at
    before update on public.whatsapp_integrations
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RPCs: SECURITY DEFINER (owner postgres), search_path '', service role only.
-- Secret shapes: visible ASCII, no spaces (a token with a newline would be
-- quoted whole in fetch's error message; same rule as canSend in
-- lib/whatsapp/wa-creds.ts).
-- ---------------------------------------------------------------------------
create function public.wa_provision_app(
    p_org uuid,
    p_meta_app_id text,
    p_app_secret text,
    p_access_token text,
    p_verify_token text
) returns table (app_id uuid, webhook_key text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_id uuid := gen_random_uuid();
    v_key text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
    v_secret uuid;
    v_token uuid;
begin
    if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
        raise exception using errcode = '22023', message = 'wa_provision_app: unknown org';
    end if;
    if p_meta_app_id is null or p_meta_app_id !~ '^[0-9]{5,25}$' then
        raise exception using errcode = '22023', message = 'wa_provision_app: meta_app_id must be 5-25 digits';
    end if;
    if p_app_secret is null or p_app_secret !~ '^[!-~]+$' or length(p_app_secret) not between 16 and 256 then
        raise exception using errcode = '22023', message = 'wa_provision_app: app secret must be 16-256 visible ASCII characters';
    end if;
    if p_access_token is null or p_access_token !~ '^[!-~]+$' or length(p_access_token) not between 20 and 4096 then
        raise exception using errcode = '22023', message = 'wa_provision_app: access token must be 20-4096 visible ASCII characters';
    end if;
    if p_verify_token is null or p_verify_token !~ '^[!-~]+$' or length(p_verify_token) > 256 then
        raise exception using errcode = '22023', message = 'wa_provision_app: verify token must be 1-256 visible ASCII characters';
    end if;

    v_secret := vault.create_secret(p_app_secret, format('wa_app:%s:app_secret', v_id), 'WhatsApp app secret');
    v_token := vault.create_secret(p_access_token, format('wa_app:%s:access_token', v_id), 'WhatsApp System User token');

    insert into public.whatsapp_apps
        (id, org_id, meta_app_id, webhook_key, app_secret_id, access_token_secret_id, verify_token_sha256)
    values
        (v_id, p_org, p_meta_app_id, v_key, v_secret, v_token, extensions.digest(p_verify_token, 'sha256'));

    return query select v_id, v_key;
end;
$$;

create function public.wa_provision_number(
    p_app uuid,
    p_phone_number_id text,
    p_waba_id text,
    p_display_phone text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_org uuid;
    v_id uuid;
begin
    select a.org_id into v_org from public.whatsapp_apps a where a.id = p_app;
    if v_org is null then
        raise exception using errcode = '22023', message = 'wa_provision_number: unknown app';
    end if;

    insert into public.whatsapp_integrations (org_id, app_id, phone_number_id, waba_id, display_phone)
    values (v_org, p_app, p_phone_number_id, p_waba_id, nullif(btrim(p_display_phone), ''))
    returning id into v_id;
    return v_id;
end;
$$;

create function public.wa_rotate_secret(
    p_app uuid,
    p_kind text,
    p_secret text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_app public.whatsapp_apps%rowtype;
    -- the same length bounds as wa_provision_app (a regex bound may not exceed 255)
    v_min int := case p_kind when 'app_secret' then 16 when 'access_token' then 20 when 'verify_token' then 1 end;
    v_max int := case p_kind when 'app_secret' then 256 when 'access_token' then 4096 when 'verify_token' then 256 end;
begin
    if v_min is null then
        raise exception using errcode = '22023', message = 'wa_rotate_secret: kind must be app_secret, access_token or verify_token';
    end if;
    if p_secret is null or p_secret !~ '^[!-~]+$' or length(p_secret) not between v_min and v_max then
        raise exception using errcode = '22023', message = format('wa_rotate_secret: invalid %s', p_kind);
    end if;
    select * into v_app from public.whatsapp_apps a where a.id = p_app for update;
    if not found then
        raise exception using errcode = '22023', message = 'wa_rotate_secret: unknown app';
    end if;

    if p_kind = 'app_secret' then
        perform vault.update_secret(v_app.app_secret_id, p_secret);
    elsif p_kind = 'access_token' then
        perform vault.update_secret(v_app.access_token_secret_id, p_secret);
    end if;
    update public.whatsapp_apps a
       set verify_token_sha256 = case when p_kind = 'verify_token'
                                      then extensions.digest(p_secret, 'sha256')
                                      else a.verify_token_sha256 end,
           updated_at = now()
     where a.id = p_app;
end;
$$;

-- For the per-app webhook (2.2c): the app behind a URL key, with its current
-- app secret (HMAC check) and the verify token's sha256 (hex, for the GET
-- handshake). An unknown key returns no row.
create function public.wa_webhook_app(p_key text)
returns table (app_id uuid, org_id uuid, status text, app_secret text, verify_token_sha256 text)
language sql
stable
security definer
set search_path = ''
as $$
    select a.id, a.org_id, a.status, s.decrypted_secret, encode(a.verify_token_sha256, 'hex')
      from public.whatsapp_apps a
      join vault.decrypted_secrets s on s.id = a.app_secret_id
     where a.webhook_key = p_key;
$$;

-- For every send (2.2c): the org's number and its app's token. The caller
-- refuses to send unless both statuses are active. No row = not configured.
create function public.wa_org_send_credentials(p_org uuid)
returns table (
    integration_id uuid,
    app_id uuid,
    phone_number_id text,
    waba_id text,
    access_token text,
    status text,
    app_status text
)
language sql
stable
security definer
set search_path = ''
as $$
    select i.id, a.id, i.phone_number_id, i.waba_id, s.decrypted_secret, i.status, a.status
      from public.whatsapp_integrations i
      join public.whatsapp_apps a on a.id = i.app_id
      join vault.decrypted_secrets s on s.id = a.access_token_secret_id
     where i.org_id = p_org;
$$;

-- Offboarding (and the only way to delete an org that has an app): the
-- number and app rows go, then their Vault secrets.
create function public.wa_offboard_org(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_secrets uuid[];
begin
    select coalesce(array_agg(x.id), '{}') into v_secrets
      from (select a.app_secret_id as id from public.whatsapp_apps a where a.org_id = p_org
            union all
            select a.access_token_secret_id from public.whatsapp_apps a where a.org_id = p_org) x;

    delete from public.whatsapp_integrations i where i.org_id = p_org;
    delete from public.whatsapp_apps a where a.org_id = p_org;
    delete from vault.secrets s where s.id = any (v_secrets);
end;
$$;

revoke all on function public.wa_provision_app(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.wa_provision_number(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.wa_rotate_secret(uuid, text, text) from public, anon, authenticated;
revoke all on function public.wa_webhook_app(text) from public, anon, authenticated;
revoke all on function public.wa_org_send_credentials(uuid) from public, anon, authenticated;
revoke all on function public.wa_offboard_org(uuid) from public, anon, authenticated;

grant execute on function public.wa_provision_app(uuid, text, text, text, text) to service_role;
grant execute on function public.wa_provision_number(uuid, text, text, text) to service_role;
grant execute on function public.wa_rotate_secret(uuid, text, text) to service_role;
grant execute on function public.wa_webhook_app(text) to service_role;
grant execute on function public.wa_org_send_credentials(uuid) to service_role;
grant execute on function public.wa_offboard_org(uuid) to service_role;
