# Fase 2 design: WhatsApp & integrations per tenant (Option C)

Status: **decided 2026-10-17** by the owner (tracker `docs/SAAS_PROGRESS.md`, D6 and D8). Owner-facing brief: [`FASE2_BRIEF_D6_D8.md`](FASE2_BRIEF_D6_D8.md).

- **D6 = C, one Meta app per client** for the closed pilot (1-5 UMKM, team-managed): each tenant owns its business portfolio, WABA, number and Meta app and pays Meta directly; no App Review and no verified Sarathi entity needed. Conditions: written authorisation + DPA from each client, named team access with 2FA (revoked when a client leaves), per-org AI quota. Revisit before tenant #6, for self-serve signup, or when a tenant needs coexistence (then: platform app, tracker 5.4).
- **D8 = Sailendra-only, partly opened later**: every Sailendra-owned feature sits behind a per-org switch (off for new tenants) and the Sailendra/MJ identity in presets and AI texts is neutralised before tenant #2; generic features (daily digest, sales/order notifications, meeting booking with "link follows") open per tenant in Fase 4 once the tenant has its own approved templates. Portal, proposal/FNA, Flow "Brief Acara" and the Sailendra Zoom stay Sailendra-only.

This document is the output of a design workflow (4 read-only mappers of the code and of Meta/Supabase docs, two competing designs, an adversarial critique of each, then a brief). The critique of this design found 0 blockers, 6 major and 7 minor issues; they are listed below and are part of the plan.

## Summary

Fase 2 design (tasks 2.1–2.7, plus the status of 2.8) under Option C.

**Webhook routing**
- Each tenant's Meta app gets its own opaque callback URL: `/api/webhook/whatsapp/<webhook_key>`.
- The URL alone tells the server which app the request claims to come from, and so which org and which app secret apply.
- The server checks HMAC-SHA256 over the raw body bytes with that app's secret, read from Supabase Vault. Only then does it parse the body or log anything. Today the body is parsed first (app/api/webhook/whatsapp/route.ts:326) and the secret comes from env (lib/whatsapp/credentials.ts:23).
- Every entry and change is routed only among that app's own numbers: by `phone_number_id` for message fields, and by `entry.id` (the WABA id) for template and account fields.
- An app belongs to exactly one org, enforced by a composite FK. A tenant can read its own app secret in its own Meta dashboard, but even then it can only inject into its own org.
- An unknown `phone_number_id` or WABA is never processed, and nothing falls back to the default org or to env credentials. The id is counted in `whatsapp_webhook_unrouted` and the batch gets 200.

**Secrets and access**
- Vault holds the app secret, a staged next secret, the System User token per app, and the 2FA PIN per number. They are reachable only through SECURITY DEFINER RPCs that only service_role can execute.
- `authenticated` loses every privilege on the WhatsApp tables. Today it holds rawdDxt plus a member FOR ALL policy (supabase/fingerprint/production.txt:464, 549).

**Sends, flags, settings**
- Every send path takes a required `WaCreds`, resolved from the org or from the receiving number. client.ts and templates.ts stop reading env.
- Sailendra-owned integrations sit behind per-org flags in `org_features`: Zoom, Resend sender, sales WA notify, digest, Portal, proposals/FNA, Flow "Brief Acara" and order WA. Flags are OFF by default and seeded ON for Sailendra. Env credentials additionally require the default org (closes KEA-7).
- Templates and Flows get a per-WABA registry and a handler for template-status webhooks.
- Timezone and meeting rules move to `org_settings`.
- The Graph API version is defined in one place and raised to v25.0.

**What can start now vs after D6**
- Independent of D6: 2.7, 2.1a lockdown, 2.2a webhook hardening, 2.2b credential plumbing, 2.4 flags, 2.3 settings, 2.6 timezone/rules, 2.5a registry, and the docs fixes. This is most of the effort, including all four L tasks.
- Needs D6 = C: 2.1b (app + Vault schema), 2.1c provisioning, 2.2c per-app route, 2.2d Sailendra cutover/contract, and 2.9 (tenant-2 runbook).
- 2.8 (Tech Provider) is not needed under C, because direct-developer apps need no App Review. It moves to 5.4.

**Sailendra rollout**
- Sailendra already has the Option C shape: its env app is its own app.
- Its env values are provisioned into Vault and read in shadow mode, then a platform switch flips the source.
- The owner then moves its callback URL to its per-app path. The old URL keeps working for Meta's 7-day retry window before the contract.
- Flags (2.4) and per-org notification settings (2.3) must be live before any second number is routed.

Sizes are estimates: S ≈ 1 day or less, M ≈ 2–4 days, L ≈ 1–2 weeks.

## Architecture

1. Invariants (all fail-closed)

- **I1. Trust comes only from the signature.** A webhook is trusted only if X-Hub-Signature-256 equals HMAC-SHA256(raw body, app secret) for the app named by the URL key. The key is only a routing id, not a secret: it appears in each Meta App Dashboard and in proxy access logs.
- **I2. One app belongs to one org.**
  - `whatsapp_apps.org_id` is NOT NULL, and `whatsapp_integrations` has a FK from (app_id, org_id) to `whatsapp_apps(id, org_id)`.
  - The webhook looks up numbers only with `WHERE app_id = <verified app>`.
  - Under C each tenant can read its own app secret, but a payload signed by tenant A's app still cannot write into tenant B.
- **I3. No default-org or env fallback on any WhatsApp path.** Today's fallbacks:
  - lib/whatsapp/credentials.ts:27-41
  - lib/settings/org-context.ts:72-74
  - lib/settings/platform-settings.ts:47-50
  - lib/whatsapp/client.ts:74-75, 176-177, 214-215, 278
  - lib/whatsapp/templates.ts:56-57, 97-98, 192-193
  - lib/ai/rag.ts:311

  Missing configuration throws WhatsAppNotConfiguredError and nothing is sent.
- **I4. Secrets live only in Vault.** They leave the database only through RPCs that only service_role can execute, called from server code with a strict service client:
  - no anon-key fallback (today: app/api/webhook/whatsapp/route.ts:334-337, app/api/queue/process/route.ts:38-41);
  - no cookie-client fallback (lib/supabase/service.ts:23-37).
- **I5. Tenants read, the team writes.** Tenant members see non-secret status only. Until the platform-admin role (3.1) exists, the Sarathi team makes every write through a service-role script (D17, docs/SAAS_PROGRESS.md:33).

2. Data (columns in schema_changes)

- **whatsapp_apps:** one row per client Meta app.
  - meta_app_id and webhook_key.
  - Vault ids of the app secret, the staged next secret and the System User token.
  - sha256 of the app's verify token.
  - graph_api_version override, status and token_status.
- **whatsapp_integrations:** the 0032 table reshaped to one row per phone number.
  - id, app_id, org_id, and phone_number_id (globally unique, as today).
  - waba_id, display_phone, and the Vault id of the 2FA PIN.
  - is_default, status, and health columns.
- **whatsapp_webhook_unrouted:** a per-app counter of unknown ids. No org_id; service_role only.
- **Settings and registries:** org_settings, org_features, org_integrations (Zoom, Resend and Portal secrets in Vault), whatsapp_templates, org_template_bindings, whatsapp_flows.

3. Server modules

- **lib/supabase/service.ts:** add `createServiceClient()`, which throws when SUPABASE_SERVICE_ROLE_KEY is missing.
- **lib/whatsapp/graph.ts:** `GRAPH_API_VERSION`, `graphUrl()`, and `graphFetch(creds, path, init)`.
- **lib/whatsapp/credentials.ts (rewritten):**
  - the `WaCreds` type;
  - `getIntegrationCreds(integrationId)`, `getOrgWhatsAppCreds(orgId)`, and `getOrgWhatsAppStatus(orgId)` (non-secret fields only);
  - `WhatsAppNotConfiguredError`;
  - a source switch, `platform_settings.wa_creds_source` = env | shadow | vault, used only during Sailendra's cutover.
- **lib/whatsapp/webhook/:**
  - `verify.ts`: raw-byte HMAC with the current and the staged secret;
  - `app-resolver.ts`: key to AppContext, with positive and negative cache;
  - `router.ts`: each entry/change becomes routed or unrouted;
  - `ingest.ts`: idempotency-first inbound write;
  - `handlers/{messages,statuses,user-id-update,templates,flows}.ts`.

  The route files only adapt HTTP.
- **Routes:**
  - new `app/api/webhook/whatsapp/[key]/route.ts`, one URL per app;
  - `app/api/webhook/whatsapp/route.ts`, Sailendra's current URL, runs the same pipeline and is deleted at the contract.
- **Settings and gates:**
  - `lib/settings/org-settings.ts`;
  - `lib/settings/features.ts` with `isFeatureEnabled`, `requireFeature` and `resolveOrgIntegration`;
  - `requireWhatsAppIntegration()` replaces `requireEnvIntegration('whatsapp')`;
  - `requireEnvIntegration` and `isDefaultOrg` (lib/settings/org-context.ts:196-216, lib/settings/org-access.ts:16-17, 98-114) are removed once no caller is left.
- **scripts/wa-provision.mjs** (plus scripts/lib/wa-provision.mjs, unit-tested):
  - phases: plan | app | number | verify | subscribe | sync | settings | rotate | status | offboard;
  - dry-run unless `--confirm`; requires `--expect-ref=<project ref>`;
  - secrets only through a hidden TTY prompt, typed by a human (never CLI args, files in the repo, or Claude's context);
  - same conventions as scripts/migrate-legacy-kb-objects.mjs:15-40.

4. Request flows

- **Inbound:**
  1. Meta calls /api/webhook/whatsapp/<key>.
  2. The key resolves to an app (RPC `wa_webhook_app`, cached).
  3. HMAC check.
  4. Parse.
  5. For each entry and change, route inside that app only.
  6. Call the handler with a RoutedContext {appId, orgId, integrationId, phoneNumberId, wabaId, creds()}.
  7. Idempotent ingest, then queue, push, media or Flow handling.
- **Outbound:**
  1. The caller gets credentials from `getOrgWhatsAppCreds(orgId)` or `ctx.creds()`.
  2. client.ts / templates.ts are called with those creds.
  3. `graphFetch` makes the request.

5. Caching (per Node process; production is one persistent Easypanel service)

- App by key: 60 s. Unknown keys are negative-cached for 60 s (LRU, 1,000 entries).
- Routing map per app: 60 s.
- Credentials per number: 60 s.
- Settings and features per org: 60 s.

Secret rotation uses a staged second secret, so no cache ever needs flushing. A suspension takes effect within 60 s.

6. Observability

- Logs carry internal uuids only (app_id, integration_id, org_id). Meta's numeric ids are masked anyway by the KEA-21 redaction of digit runs of 8 or more (lib/utils/logger.ts:35).
- Counters:
  - signature failures per app;
  - unrouted ids (stored in the table);
  - events dropped for suspended apps or numbers;
  - 503 answers;
  - token_status and quality per number.

7. Why one URL per app

The server must know the tenant before it can verify the signature. Alternatives considered:
- **(a) Parse first, then look up phone_number_id.** This was the design before cb709bc (git show cb709bc^:lib/whatsapp/credentials.ts:33-54). Rejected because it:
  - parses unauthenticated input;
  - makes the endpoint an oracle for which numbers are registered;
  - lets a batch signed by one app carry entries for another org.
- **(b) One URL that tries every active secret.** Rejected: it loads every tenant's secret on each request and grows with N. It survives only as the two-secret check during a rotation.
- **(c) Per-WABA override_callback_uri.** Rejected: template and account-level webhooks cannot be overridden (https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks.md), and C already has one callback per app.

8. Forward compatibility

If D6 later moves to one platform app (Option B with Embedded Signup, 5.4), the same pipeline works:
- there is one app row whose single-org binding is relaxed, and the org comes from the number row per entry;
- routing is already per entry, so only the composite FK and the one-org assertion change.

## Schema changes

**Conventions for every migration below:**
- Migrations are named, not numbered: each PR takes the next free number when it is opened. 0067-0072 already went to chat-media, realtime, the whatsapp_integrations lockdown (below), ops_events (3.5), org quotas (3.4) and the webhook ingest (2.2a part 2), so the names below (wa_apps_vault, ...) get whatever number is free then.
- Each migration follows supabase/README.md:14-37 and :313-384: a pgTAP test that fails without it, pending lines in fingerprint/expected-diff.txt, owner review (D1), `apply_migration`, then refresh production.txt.
- New tables must revoke privileges explicitly. 0063 removed `anon` from the default privileges, but `authenticated` still gets automatic grants, and EXECUTE on functions still goes to anon (supabase/README.md:27-37).

---

**wa_integrations_lockdown (2.1a; applied as 0069_whatsapp_integrations_service_role_only)**

Independent of D6. Compatible with the live code, because no code reads this table (lib/whatsapp/credentials.ts:4-7).

```sql
do $$ begin
  if exists (select 1 from public.whatsapp_integrations) then
    raise exception '0069: whatsapp_integrations has rows, review them first';
  end if;
end $$;

drop policy "org members manage their whatsapp integration" on public.whatsapp_integrations;

revoke all on table public.whatsapp_integrations from anon, authenticated;

create policy "service_role only" on public.whatsapp_integrations
  for all to anon, authenticated using (false) with check (false);
```

- **Deny policy:** the same one message_queue and rate_limits already use (production.txt:452, 460). It keeps guards 3 and 4 of 070 green.
- **Privileges:** unlike those two tables, the privileges are revoked as well, so TRUNCATE, REFERENCES and TRIGGER go away too (production.txt:549).
- **Tests:**
  - 010 drops this table from `check_tenant_table` and `check_cross_org_blind` (010:138-141, :212).
  - A new helper `tests.check_role_denied(table, cols, vals, set, who)`, a generalised copy of `check_anon_denied` (000-setup-tests-hooks.sql:340-370), is run as a member. It expects 'permission denied for table whatsapp_integrations'.
  - A catalog block in the style of 110 asserts anon and authenticated have no SELECT, INSERT, UPDATE or DELETE.

---

**org_settings_features (2.3, 2.4, 2.6)**

Independent of D6. Expand only.

```sql
create table public.org_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  timezone text not null default 'Asia/Jakarta'
    check (timezone in ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura')),
  meeting_open_hour     smallint not null default 10 check (meeting_open_hour between 0 and 23),
  meeting_close_hour    smallint not null default 22 check (meeting_close_hour between 1 and 24),
  meeting_days          smallint[] not null default '{1,2,3,4,5}'
    check (meeting_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  meeting_max_per_day   smallint not null default 4  check (meeting_max_per_day between 1 and 50),
  meeting_buffer_min    smallint not null default 15 check (meeting_buffer_min between 0 and 240),
  meeting_duration_min  smallint not null default 40 check (meeting_duration_min between 10 and 240),
  meeting_horizon_days  smallint not null default 30 check (meeting_horizon_days between 1 and 365),
  notify_sales_whatsapp text[] not null default '{}',
  notify_sales_email    text[] not null default '{}',
  email_sender_name text,
  email_reply_to text,
  digest_recipients text[] not null default '{}',
  digest_hour smallint not null default 8 check (digest_hour between 0 and 23),
  followup_stale_days   smallint not null default 3,
  followup_horizon_days smallint not null default 7,
  updated_at timestamptz not null default now(),
  check (meeting_close_hour > meeting_open_hour)
);

create table public.org_features (
  org_id uuid not null references public.organizations(id) on delete cascade,
  feature text not null check (feature in (
    'meeting_tools','zoom_meetings','meeting_email','meeting_notify_whatsapp',
    'followup_digest','flow_brief_acara','portal_handoff','proposal_email',
    'proposal_documents','order_status_whatsapp')),
  enabled boolean not null default false,
  note text,
  updated_at timestamptz not null default now(),
  primary key (org_id, feature)
);

create table public.org_integrations (
  org_id uuid not null references public.organizations(id) on delete restrict,
  provider text not null check (provider in ('zoom','resend','portal')),
  config jsonb not null default '{}'::jsonb,  -- non-secret: account_id/client_id/host_user | from_email/domain | base_url
  secret_id uuid,                             -- vault.secrets.id
  status text not null default 'active' check (status in ('active','disabled')),
  updated_at timestamptz not null default now(),
  primary key (org_id, provider)
);
```

- **Access:**
  - org_settings and org_features: `revoke all from anon, authenticated; grant select to authenticated;` with a policy FOR SELECT `using (private.is_org_member(org_id))`. Members can read but never write: roles are only enforced from Fase 3 (SAAS_PROGRESS.md:85).
  - org_integrations: revoke all, plus the 'service_role only' deny policy.
- **Triggers:** `set_updated_at` triggers; the function already exists (production.txt:302).
- **Backfill:**
  - One org_settings row per organization. Its defaults equal today's constants (lib/meetings/rules.ts:5-14, lib/ai/tools.ts:1121-1125).
  - org_features rows with `enabled=true` for every feature, for the org in `platform_settings.default_org_id` only. Sailendra's behaviour is therefore unchanged. Other orgs get no rows, which means OFF.
- **RPCs:** `org_integration_put(p_org, p_provider, p_config jsonb, p_secret text)` and `org_integration_get(p_org, p_provider)` returning (config, secret, status).
  - SECURITY DEFINER, `search_path ''`, owner postgres.
  - EXECUTE revoked from public, anon and authenticated; granted to service_role.
  - Secrets are written with `vault.create_secret` / `vault.update_secret` and read from `vault.decrypted_secrets`.
- **Tests:**
  - New helper `tests.check_tenant_read_only`: precondition; reads own row; reads no other org's row; INSERT, UPDATE and DELETE on its own row fail with 42501 'permission denied for table'.
  - anon is denied; RPC grants are covered in 050; the seed rows are asserted.
  - Guard 13 is unaffected because every key contains org_id.

---

**wa_templates_flows (2.5)**

Independent of D6.

```sql
create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text not null,
  meta_template_id text not null,
  name text not null,
  language text not null,
  category text,
  status text not null,
  quality text,
  components jsonb not null default '[]'::jsonb,
  reason text,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, meta_template_id),
  unique (org_id, waba_id, name, language)
);

create table public.org_template_bindings (
  org_id uuid not null references public.organizations(id) on delete cascade,
  purpose text not null check (purpose in ('meeting_notify','followup_digest','brief_acara')),
  template_name text not null,
  language text not null default 'id',
  primary key (org_id, purpose)
);

create table public.whatsapp_flows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text not null,
  meta_flow_id text not null,
  name text not null,
  handler text not null default 'generic' check (handler in ('brief_acara','generic')),
  template_name text,
  flow_json_version text,
  status text not null default 'PUBLISHED',
  created_at timestamptz not null default now(),
  unique (org_id, meta_flow_id)
);
```

- **Access:** members can SELECT (template picker and status display); only the service role writes.
- **Tests:** the same read-only helper.

---

**wa_apps_vault (2.1b)**

Needs D6 = C. Precondition: the table is empty, as in 0069. Compatible with the live code, because nothing reads whatsapp_integrations.

```sql
create table public.whatsapp_apps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  meta_app_id text not null check (meta_app_id ~ '^[0-9]{5,25}$'),
  webhook_key text not null check (webhook_key ~ '^[A-Za-z0-9_-]{32}$'),
  webhook_key_prev text,
  webhook_key_prev_expires_at timestamptz,
  app_secret_id uuid not null,
  app_secret_next_id uuid,
  access_token_secret_id uuid not null,
  verify_token_sha256 bytea not null check (octet_length(verify_token_sha256) = 32),
  graph_api_version text check (graph_api_version ~ '^v[0-9]{2}\.0$'),
  status text not null default 'active' check (status in ('active','suspended','disabled')),
  token_status text not null default 'unknown' check (token_status in ('unknown','valid','invalid')),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_apps_meta_app_id_key unique (meta_app_id),
  constraint whatsapp_apps_webhook_key_key unique (webhook_key),
  constraint whatsapp_apps_id_org_key unique (id, org_id)
);

-- reshape the empty 0032 table into one row per number
alter table public.whatsapp_integrations drop constraint whatsapp_integrations_pkey;

alter table public.whatsapp_integrations
  drop column access_token,
  drop column app_secret,
  add column id uuid not null default gen_random_uuid(),
  add column app_id uuid not null,
  add column pin_secret_id uuid,
  add column is_default boolean not null default true,
  add column status text not null default 'active' check (status in ('active','paused','disabled')),
  add column quality_rating text,
  add column last_verified_at timestamptz,
  add column last_error_code integer,
  alter column waba_id set not null,
  add constraint whatsapp_integrations_pkey primary key (id),
  add constraint whatsapp_integrations_app_fkey foreign key (app_id, org_id)
    references public.whatsapp_apps(id, org_id) on delete restrict,
  add constraint whatsapp_integrations_ids_check
    check (phone_number_id ~ '^[0-9]{5,25}$' and waba_id ~ '^[0-9]{5,25}$');

-- the org FK changes from CASCADE to RESTRICT: offboarding must delete the Vault secrets first
drop index public.whatsapp_integrations_phone_number_id_idx;  -- duplicates the unique key, production.txt:435-436

create unique index whatsapp_integrations_org_default_key
  on public.whatsapp_integrations (org_id) where is_default;

create index whatsapp_integrations_app_waba_idx
  on public.whatsapp_integrations (app_id, waba_id);

create table public.whatsapp_webhook_unrouted (
  app_id uuid not null references public.whatsapp_apps(id) on delete cascade,
  kind text not null check (kind in ('phone_number_id','waba_id')),
  external_id text not null,
  field text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  hits bigint not null default 1,
  primary key (app_id, kind, external_id, field)
);
```

- **Access:**
  - whatsapp_apps and whatsapp_integrations: RLS on, revoke all from anon and authenticated, plus the 'service_role only' deny policy.
  - whatsapp_webhook_unrouted: like platform_settings, with RLS on, no policy and no grants (production.txt:521-523).
- **Triggers:** `set_updated_at`.
- **RPCs.** All are `language plpgsql`, SECURITY DEFINER, `set search_path = ''`, owner postgres. Each has `revoke all on function ... from public, anon, authenticated` and `grant execute ... to service_role`.
  - **`wa_provision_app(p_org uuid, p_meta_app_id text, p_app_secret text, p_access_token text, p_verify_token text)`** returns table(app_id uuid, webhook_key text).
    - Validates its inputs.
    - Generates `webhook_key` as base64url of `extensions.gen_random_bytes(24)` (pgcrypto is in schema extensions, production.txt:282).
    - Calls `vault.create_secret(p_app_secret, 'wa_app:<id>:app_secret', 'WhatsApp app secret')`, and does the same for the token.
    - Stores only `extensions.digest(p_verify_token, 'sha256')` for the verify token.
  - **`wa_provision_number(p_app uuid, p_phone_number_id text, p_waba_id text, p_display_phone text, p_pin text, p_is_default boolean)`** returns uuid. The org is taken from the app row.
  - **`wa_rotate_secret(p_kind text, p_id uuid, p_secret text)`**, where p_kind is one of:
    - `app_secret_next`: stage a new secret;
    - `app_secret_promote`: next becomes current, and the old Vault row is deleted;
    - `access_token`;
    - `verify_token`;
    - `pin`;
    - `webhook_key`: the old key stays valid for 7 days through `webhook_key_prev`.
  - **`wa_set_status(p_kind text, p_id uuid, p_status text)`** and **`wa_set_health(p_app uuid, p_integration uuid, p_token_status text, p_quality text, p_error_code int)`**.
  - **`wa_webhook_app(p_key text)`** returns (app_id, org_id, status, app_secret, app_secret_next, verify_token_sha256_hex, graph_api_version). It also matches `webhook_key_prev` until it expires, and returns zero rows for an unknown key.
  - **`wa_send_credentials(p_integration uuid)`** returns (org_id, app_id, phone_number_id, waba_id, access_token, graph_api_version, status, app_status, token_status).
  - **`wa_note_unrouted(p_app uuid, p_kind text, p_external_id text, p_field text)`** upserts the row with `hits + 1`.
  - **`wa_offboard_org(p_org uuid)`** deletes the Vault rows first, then the number and app rows.
- **Non-secret routing reads** use the service client directly: `select id, org_id, phone_number_id, waba_id, status from whatsapp_integrations where app_id = $1`.
- **Tests:** new file 190_whatsapp_vault.test.sql, plus additions to 050 and 070.
  - No anon or authenticated privilege on the three tables.
  - Every wa_* function is executable by service_role only; guards 6 and 7 are unchanged.
  - A provisioning round trip returns the token only through the RPC.
  - No column named access_token or app_secret is left.
  - `vault.secrets.secret` differs from the plaintext.
  - Attaching a number to another org's app fails with 23503.
  - A duplicate phone_number_id fails with 23505.
  - An unknown key returns no rows.
  - rotate and promote work as described.
  - Offboarding leaves no Vault row behind.
- **Guard 13** allowlist (070:143-175) gains `whatsapp_apps_meta_app_id_key` and `whatsapp_apps_webhook_key_key`, reviewed as platform-global ids; the list in supabase/README.md:52-56 is updated to match.
- **010 fixtures:** use numeric ids under an app row created as postgres.
- **Open check:** the supabase_vault version in production is unverified. Read `pg_extension` before applying.

**As built (2026-11-20, migration 0073_wa_apps_vault, trimmed for the pilot; owner decision D29).** Production runs supabase_vault 0.3.1 and pgcrypto 1.3 in `extensions` (read 2026-11-20). Kept: `whatsapp_apps` (secrets in Vault, verify token as sha256, `webhook_key`, status), `whatsapp_integrations` reshaped to one row per number, and six service-role RPCs:
- `wa_provision_app(org, meta_app_id, app_secret, access_token, verify_token)`;
- `wa_provision_number(app, phone_number_id, waba_id, display_phone)`;
- `wa_rotate_secret(app, kind, secret)`, which updates the same Vault row, so secret names never collide;
- `wa_webhook_app(key)`;
- `wa_org_send_credentials(org)`, by org, since there is one number per org;
- `wa_offboard_org(org)`.

The design review's points are fixed:
- the org FKs are RESTRICT, so offboarding deletes the Vault secrets;
- UNIQUE(org_id) on both tables gives one app and one number per org until chats carry the number;
- the shape checks are length checks, because a Postgres regex bound cannot exceed 255.

Left out until a tenant needs it:
- `app_secret_next` and the `webhook_key_prev` grace period. A rotated app secret applies at once, and webhooks signed with the old one fail and are retried by Meta;
- `token_status`, quality and error columns (the send reports a bad token);
- a per-app Graph version;
- the stored 2FA PIN;
- `wa_set_status` / `wa_set_health` (the service role updates `status` directly);
- `whatsapp_webhook_unrouted` (2.2c raises an ops event instead).

Tests: `230_wa_apps_vault.test.sql`, plus 010, 050 and 070 (guard 13 gains the two app keys).

**As built (2026-11-20, task 2.1c, trimmed): `scripts/wa-provision.mjs`.** The script has seven phases:
- `status`;
- `app`, which takes secrets;
- `number`;
- `verify`;
- `subscribe`;
- `rotate`, which takes secrets;
- `offboard`.

It follows the D17 conventions: a dry-run without `--confirm`, `--expect-ref`, and a service-role key check. Design-review fix (D17 exception): `app` and `rotate` refuse to run without an interactive terminal. The owner therefore types the secrets himself into a hidden prompt, and they never pass through an agent, an argument, a file or the environment.

`app` and `rotate --kind=verify_token` generate the verify token and show it once.

`verify` uses the Vault token and an `appsecret_proof`. It checks three things:
- `GET /{phone_number_id}` answers, which also proves the stored app secret belongs to the token's app;
- `GET /{waba_id}/phone_numbers` lists the number;
- `GET /{waba_id}/subscribed_apps` lists the app.

Left out for now:
- plan, sync and settings (2.5a and 2.3 are deferred, D29);
- the daily health job (a send reports a bad token);
- the masked status view in Settings and onboarding, which comes with 2.2c, when tenants have numbers.

**As built (2026-11-25, task 2.2c PR-1; owner decisions D32-D34).** A new per-app route `app/api/webhook/whatsapp/[key]/route.ts` runs next to the legacy URL. The legacy route and every send stay on env and do not change.

GET is the handshake (`lib/whatsapp/webhook/handshake.ts`). It answers 403 unless all of these hold:
- the key has the right shape;
- `hub.mode=subscribe`, and a token and a challenge are present;
- the app row exists and is active;
- the sha256 of the token matches (constant-time compare).

On success it echoes the challenge, as the legacy route does.

POST goes through `processAppWebhook` in `pipeline.ts`, in this order:
1. A malformed key gets 404, before the body is read.
2. A body over the cap gets 413.
3. A missing or malformed signature header gets 403, with no database call.
4. `wa_webhook_app` fails: 503 plus `webhook_error`. An unknown key gets 404.
5. The HMAC is checked against the Vault app secret. A mismatch gets 403 plus `webhook_signature_invalid` with the app's org.
6. A suspended app gets 200 and the batch is dropped with a log line.
7. `wa_org_send_credentials` fails: 503 plus `webhook_error`. No number gets 503 plus `webhook_unconfigured`. A paused number gets 200 and the batch is dropped.
8. The shared `walkBatch` runs with the app's org and Vault credentials, which it now takes as an injected resolver.

Routing stays inside the signing app's own number, so a payload signed by app A never writes into another org. `getDefaultOrgIdStrict` is never called on this path. The readers `vaultWebhookApp` / `vaultOrgCreds` (`lib/whatsapp/credentials.ts`) are pinned to the webhook modules by the env-shim test.

Deviations from the original design:
- no `wa_creds_source` switch or shadow mode (D32);
- no `legacy_webhook_key`;
- no caches, no unrouted table, no WABA-level check;
- a bad signature gets 403, not 401;
- no `appsecret_proof` on sends (D33).

Next: the owner moves Sailendra's callback, then the 48 h soak, then PR-2 (2.2d) moves every send to Vault and deletes the legacy route and env.

---

**wa_legacy_contract (2.2d)**

Applied only after a build without the legacy route is live and 7 days have passed with no legacy traffic.

```sql
drop function public.verify_webhook_token(text);

delete from public.platform_settings
where key in ('whatsapp_verify_token','whatsapp_webhook_url','legacy_webhook_key','wa_creds_source');
```

- 110 and 050 are updated.
- `PLATFORM_SETTING_KEYS` (lib/settings/platform-settings.ts:21-25) shrinks to `default_org_id`.

---

**Deferred:** a nullable `wa_integration_id` on whatsapp_chats and message_queue. It is only needed when an org gets a second number, so that replies leave from the number the customer wrote to.

**whatsapp_chats and whatsapp_messages:** 2.2a part 2 (PR-C2) adds the expand migration 0072_wa_inbound_ingest: `whatsapp_messages.wa_timestamp` (Meta's send time of an inbound message; created_at stays the arrival time), a column comment on the `syn.` keys `wa_message_id` holds for a message Meta sent without an id, the service-role-only work table `whatsapp_inbound_work` (used from PR-C3), and the functions wa_ingest_inbound (one transaction per inbound message: redelivery gate, rate limit, chat, message row, summary by Meta time, unread, AI quota and queue job), wa_apply_statuses (statuses forward only, on the org's own outbound rows), claim_inbound_work and cleanup_old_inbound_work. Org-scoping the remaining writes is a code change, and the unique index (org_id, wa_message_id, role) already exists (uniq_whatsapp_messages_org_wamid).

## Webhook routing

**Route and configuration**

- New route: `app/api/webhook/whatsapp/[key]/route.ts`, with the Node.js runtime and dynamic rendering.
- Each client's App Dashboard uses the callback URL `https://<host>/api/webhook/whatsapp/<webhook_key>` and that app's own random verify token.
- proxy.ts already excludes /api (proxy.ts:10-24).
- The new route must be added to the auth-coverage EXEMPT list (app/api/__tests__/route-auth-coverage.test.ts:33-39), because it authenticates with HMAC.

**GET (subscription check)**

1. Reject with 403 unless all of these hold:
   - the key matches `^[A-Za-z0-9_-]{32}$`;
   - `hub.mode` is `subscribe`;
   - `hub.verify_token` is present;
   - `hub.challenge` matches `^[0-9]{1,32}$`. Meta documents it as an int (https://developers.facebook.com/docs/graph-api/webhooks/getting-started).
2. Look up the app with `resolveApp(key)` (RPC `wa_webhook_app`, cached). An unknown key or a disabled app also gets 403.
3. If `timingSafeEqual(sha256(hub.verify_token), stored hash)`, answer 200 with the challenge as text/plain. Otherwise 403.
4. Every failure returns the same 403. The plaintext `===` fallback (lib/settings/app-settings.ts:122-125) and the env fallback (:100-103) disappear.

**POST**

1. **Cheap rejections, no database access:**
   - more than 3 MB, by content-length or by counting while reading the stream: 413. Meta's maximum payload is 3 MB (https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks);
   - a key that fails the regex: 404;
   - an X-Hub-Signature-256 header that is missing or not `sha256=<64 hex>`: 401.
2. **Read the raw body:** `Buffer.from(await request.arrayBuffer())`. The HMAC must cover the exact bytes. Today the route uses `request.text()` and re-encodes the string as UTF-8 (route.ts:314, lib/whatsapp/security.ts:21-79).
3. **Resolve the app** with `resolveApp(key)`:
   - unknown key: 404, negative-cached for 60 s;
   - RPC or database error: 503, so Meta retries. There is never a default org.
4. **Verify the signature:**
   - Compute HMAC-SHA256 over the raw bytes with `app_secret`. If that fails and `app_secret_next` is set, try it too (the rotation window).
   - On failure answer 401 and log `signature mismatch app=<uuid>`, without the body or the header value.
   - `WHATSAPP_WEBHOOK_SKIP_SIGNATURE` is deleted (route.ts:319-320 and 355-360, .env.example:42). Tests sign their fixtures with a test secret.
5. **App status:** if the app is suspended or disabled, answer 200 and drop the request, with a log line and a counter. A suspended tenant's traffic is deliberately not stored, and Meta should not retry it for days.
6. **Parse:**
   - Run `JSON.parse` in try/catch. On failure, answer 200 and log an error: a signed body that cannot be parsed will never succeed on retry.
   - If `body.object` is not `whatsapp_business_account`, answer 200 and log a warning. Today this case gets 404 (route.ts:766-769), which makes Meta retry.
7. **Load the routing map** for the app: all numbers `WHERE app_id = app.id`, cached for 60 s. It provides:
   - `byPhone`: phone_number_id to {integrationId, orgId, wabaId, status};
   - `byWaba`: waba_id to orgId.
8. **Route every change.** For each entry in `body.entry` (check it is an array; at most 1,000 changes in total, the rest only logged), take `wabaId = String(entry.id)`.
   - **Why entry.id is the WABA id:** the template-status reference defines it so (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update). The messages reference example uses the same value (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages), so for message fields this is inferred, not stated.

   Then, for each change in `entry.changes`:
   - **a.** Take `field = change.field` and `value = change.value ?? {}`.
   - **b. Message-level fields:** if `value.metadata?.phone_number_id` is present, look up `n = byPhone.get(id)`. If there is no n, or `n.wabaId !== wabaId`, the change is UNROUTED with kind `phone_number_id`. This covers messages, statuses and user_id_update.
   - **c. WABA-level fields** (message_template_status_update, message_template_quality_update, template_category_update, account_update, phone_number_quality_update and similar): look up the org with `byWaba.get(wabaId)`. If none, the change is UNROUTED with kind `waba_id`.
   - **d.** If the number is paused or disabled, drop the change and count it.
   - **e.** Build `ctx = {appId, orgId, integrationId, phoneNumberId, wabaId, creds: () => getIntegrationCreds(integrationId)}`. The credentials are fetched lazily.
   - **f. Dispatch.** Each call gets its own try/catch, and errors are classed as retryable (network, PostgREST 5xx, timeout) or permanent:
     - **messages:**
       - For every `value.statuses[]`, update the status scoped to the org: `.eq('org_id', ctx.orgId).eq('wa_message_id', s.id)`. Today this update is not scoped (route.ts:436-439). The BSUID backfill stays as in route.ts:422-434.
       - For every `value.messages[]`, not only the first (route.ts:453-455), pick the contact as `value.contacts.find(c => c.wa_id === m.from || c.user_id === m.from_user_id)`, or the only contact if there is exactly one. Today the code always uses `contacts[0]` (route.ts:477-487). Then call `ingestMessage(ctx, m, contact)`.
       - `value.errors` is logged.
     - **user_id_update:** `handleUserIdUpdate(ctx.orgId, value)`, unchanged (route.ts:70-123).
     - **Template fields:** the 2.5 handler.
     - **Anything else:** a debug log line. Unlike today, it no longer returns early for the rest of the batch.
9. **`ingestMessage(ctx, m, contact)`, idempotency first:**
   1. Resolve `contactKey` with the org-scoped `resolveContactKey` (route.ts:28-50). If there is none, skip the message.
   2. Make sure the chat row exists: upsert `{org_id, phone_number}` with `ignoreDuplicates`. All other columns have defaults (production.txt:156-183).
   3. Insert the `whatsapp_messages` row. Media rows are inserted with `media_url = null`. A 23505 on (org_id, wa_message_id, role) (uniq_whatsapp_messages_org_wamid) means a redelivery: stop here, with no side effects.
   4. Only for a new row: update the chat summary (last_message, last_inbound_at, bsuid, verified_phone), run `bump_unread`, send the push, then handle the type:
      - **text:** the rate limit check (its warning is sent with `ctx.creds()`), then enqueue if `ai_enabled`;
      - **media:** download with `ctx.creds()` and update media_url and mime. If the download fails, the placeholder stays and a system note is added;
      - **interactive nfm_reply:** Flow dispatch (2.5);
      - **contacts:** store `verified_phone`;
      - **system `user_changed_user_id`:** the same move as user_id_update. The payload shape is unverified, so an unparsable one is only logged;
      - **other types:** stored as a placeholder row.

   **Why this order:**
   - Today the queue is filled before the history is written (route.ts:641-662 versus 667-759).
   - The queue's wamid dedup index (production.txt:386) is pruned after 24 h (app/api/queue/process/route.ts:56-69).
   - Meta retries a non-200 for up to 7 days, so a late retry could produce a second AI reply.
   - With the message row as the gate, which is never pruned, a retry is harmless.
10. **Response:**
    - 200 `EVENT_RECEIVED` when every change was processed, dropped, or recorded as unrouted.
    - 503 when at least one retryable failure happened. Meta then retries the whole batch: step 9.3 dedups what was already stored, and status updates and user_id_update are idempotent.
    - Heavy work stays asynchronous: the AI runs through the queue, and media download runs after the row exists.

**Unknown phone_number_id (or unknown WABA for a WABA-level field)**

This case happens after a successful signature check. The payload is authentic, because it came through this tenant's own Meta app, but it names a number the team has not provisioned under this app. Examples are a second number the client added to its WABA, the Meta test number, or a number that belongs to another app. Then:
- Nothing is written to tenant tables, nothing is sent, and no default org or env credential is consulted.
- `wa_note_unrouted(app_id, 'phone_number_id', id, field)` increments a counter.
- A warning is logged with the app uuid and a hash `h<hash>` of the id.
- The rest of the batch continues, and the answer stays 200, so Meta does not retry something that will never route.
- Ops reads `whatsapp_webhook_unrouted` daily and alerts when hits > 0 in the last 24 h. The fix is to provision the number; events received before that are lost, by design.

A 4xx answer, which would keep Meta retrying for up to 7 days, was rejected. It would also hold back the routable entries of the same batch, and in the runbook provisioning always comes before the webhook is configured.

**No oracle for registered numbers:**
- The key has 192 bits of randomness.
- `phone_number_id` is never read before the signature is verified.
- Every verified batch answers 200, whatever it contains.

**Legacy URL `/api/webhook/whatsapp` (Sailendra's current callback)**

- **Phase 0 (2.2a, before D6):** the same pipeline runs with a fixed AppContext.
  - The secret is the env `WHATSAPP_APP_SECRET`.
  - The org is `platform_settings.default_org_id`, read strictly: a read error gives 503, never the SEED_ORG_ID fallback (org-context.ts:72-74, platform-settings.ts:47-50).
  - The routing map has one number: env `WHATSAPP_PHONE_NUMBER_ID` and env `WHATSAPP_BUSINESS_ACCOUNT_ID`. Entries for any other number are dropped and logged. Today they land in Sailendra's org; a retired number that is still subscribed would be an example (unverified).
  - GET keeps `verify_webhook_token` (0062:152-172) but loses the plaintext fallback.
- **Phase 1 (after wa_apps_vault and Sailendra's provisioning):** the AppContext is `wa_webhook_app(platform_settings.legacy_webhook_key)`, Sailendra's app row, which holds the same secret value as env. Behaviour is then identical to the per-app route.
  - While `wa_creds_source` is `shadow`, the legacy route still verifies with the env secret and only logs whether it matches Vault.
- **Contract:** the legacy route is deleted once the owner has moved Sailendra's callback URL and 7 days have passed without traffic on it.

**Tests** (new, in lib/whatsapp/webhook/__tests__, reusing lib/whatsapp/__tests__/fakeSupabase.ts):
- A bad or missing signature gives 401, with no database call.
- An unknown key gives 404, without parsing.
- The staged secret is accepted.
- A suspended app gives 200 and nothing is written.
- A batch of 2 entries, each with 2 changes of 2 messages, stores all 8 messages.
- An unknown number mixed with known ones: only the known ones are stored, and the unknown one is recorded as unrouted.
- A number that belongs to another app is recorded as unrouted (the cross-tenant attempt).
- A WABA mismatch is recorded as unrouted.
- A duplicate redelivery after the queue row was pruned causes no second enqueue and no second push.
- A status update never touches another org's row with the same wamid.
- A retryable database error gives 503.
- A non-WABA object gives 200.

## Send paths

**Core API (2.2b, independent of D6)**

- **The credentials type:**
  ```ts
  type WaCreds = {
    orgId: string;
    integrationId: string | null; // null only in the Phase-0 env shim
    phoneNumberId: string;
    wabaId: string;
    accessToken: string;
    graphVersion: string;
  };
  ```
- **lib/whatsapp/client.ts:**
  - Signatures become `sendWhatsAppMessage(creds, to, text, contextId?)`, `uploadWhatsAppMedia(creds, ...)`, `sendWhatsAppMedia(creds, ...)` and `downloadWhatsAppMedia(creds, mediaId)`.
  - `creds` is required, and the env fallbacks are removed (client.ts:74-75, 176-177, 214-215, 278).
  - The media GET adds `?phone_number_id=<creds.phoneNumberId>`, so Meta only answers for media of that number (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media).
  - The User-Agent becomes platform-neutral (client.ts:305).
- **lib/whatsapp/templates.ts:**
  - `listTemplates(creds, {status, after})`, `getTemplateDefinition(creds, ...)` and `sendTemplateMessage(creds, opts)`.
  - No env reads any more (templates.ts:55-57, 97-98, 192-193). The WABA is `creds.wabaId`.
- **lib/whatsapp/credentials.ts:**
  - `getOrgWhatsAppCreds(orgId)` returns the org's active `is_default` number.
  - `getIntegrationCreds(integrationId)` returns a specific number.
  - Both throw `WhatsAppNotConfiguredError` when there is no number, the number is paused, the app is suspended, or `token_status` is invalid. They never fall back to env.
  - **Phase-0 implementation (before wa_apps_vault):** env creds only when `orgId` equals the default org, read strictly; otherwise they throw. The interface is the same, so every call site is refactored only once.
- **Static test:** no file outside the env shim may read `process.env.WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` or `WHATSAPP_BUSINESS_ACCOUNT_ID`. Since PR-D, lib/whatsapp/credentials.ts is the only file in app/, lib/, components/ and the root (tests excluded) that reads them (lib/whatsapp/__tests__/env-shim.test.ts); the operator scripts scripts/test-webhook.js and scripts/test-whatsapp-local.mjs still read WHATSAPP_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID from the operator's env. At the contract its env reads are deleted and the allowlist becomes empty.

**As built (PR-D, 2026-10-31)**

- **Modules:**
  - lib/whatsapp/wa-creds.ts holds `WaCreds`, `WhatsAppNotConfiguredError` and `canSend`/`assertCanSend`. It has no dependencies, so client.ts and templates.ts import nothing from the resolver.
  - lib/whatsapp/credentials.ts is the credential resolver; in Phase 0 it is the env shim: `getOrgWhatsAppCreds(orgId, client?)`, `resolveWhatsAppContext(client)` (the webhook's receiving number; its token may be empty, because storing needs none and each send checks), `envWebhookApp()` and `envWhatsAppSendConfigured()`.
  - lib/whatsapp/integration.ts holds `requireWhatsAppIntegration()`.
  - `wabaId` is `string | null`: null when it is not configured. Text sends need no WABA. `listApprovedTemplates` refuses without one, so the dashboard template list and send-template fail. `sendTemplateMessage` still sends (digest, sales notify), but its FLOW-button lookup then fails silently, so Meta rejects a template that has a FLOW button (131009/132018).
- **Static test:** it parses every source file in app/, lib/ and components/, and every source file at the root. Any naming of the four variables in code counts as a read: a property access on any object, an element access, a destructuring binding, or a string literal that is exactly the name. It also pins `resolveWhatsAppContext` and `envWebhookApp` to the webhook (lib/whatsapp/webhook/pipeline.ts): they hand out the default org's credentials without an org check, so any other file that names either one in code fails the test, whatever the import form (named, aliased, namespace, re-export, dynamic or relative).
- **A usable token** is visible ASCII without spaces (`canSend`). A token with a line break or another control character inside counts as not configured. Otherwise fetch would quote the whole Authorization header in its error, and that message would reach responses, queue rows and logs.
- **Queue:**
  - The credentials are read per conversation, without a cache: one strict platform_settings read per conversation.
  - An org without a number fails its jobs at once (`error_message` `whatsapp_not_configured`), with a note for the operators and the alert kind `whatsapp_not_configured`. That kind needs no migration: ops_events.kind is only checked against a pattern.
- **Digest:** it reads the credentials before it claims the day. A read error leaves the day unclaimed, so the next minute's tick tries again.
- **Not done here, on purpose:**
  - The media GET does not add `?phone_number_id=`. Meta documents that check for media "uploaded on" a number and does not say whether media a customer sent counts. Verify it on a test number (2.9 rehearsal) before adding it.
  - `getIntegrationCreds(id)` comes with the Vault resolver (2.2c): there are no number rows before 2.1b.
  - `graphFetch` and `appsecret_proof` come with 2.2c. The version per credential is in: `graphUrl(path, creds.graphVersion)`.
  - The template call is still `listApprovedTemplates(creds, limit?)`; the paginated `listTemplates` is 2.5a.
  - Feature flags and org_settings recipients are 2.4/2.3. The sales notify and the digest still take their recipients from env, but send only from the org's own number. Once another org's number is routed, a booking by its AI therefore sends no WhatsApp notification from the default org's number. (Since 2.4, D26, the meeting tools are offered to the default org only, so Zoom and the invite email are no longer reachable from another org.) (Today only the default org receives WhatsApp messages, and schedule_meeting exists only in WhatsApp conversations, not in the dashboard test chat.)
  - `getOrgWhatsAppStatus` comes with 2.1c. The settings page and the onboarding checklist use `envWhatsAppSendConfigured()`.
  - Order notifications have no feature flag yet (2.4). They now resolve a BSUID key to the verified phone (`resolveSendTarget`).

**Call sites**

Every one gets its own org's credentials, and none can reach another org's number.

1. **Webhook rate-limit warning** (route.ts:619-625): `ctx.creds()` of the receiving number.
2. **Webhook inbound media download** (route.ts:592-606, calling :196): `ctx.creds()`. The dedup check gets `.eq('org_id')` (route.ts:183-188).
3. **Webhook Flow confirmation** (route.ts:553-563, calling lib/whatsapp/flow-response.ts:307-308): `ctx.creds()`. `handleFlowReply` receives `creds` instead of `phoneNumberId` and `accessToken`.
4. **Queue AI reply** (lib/whatsapp/queue-db.ts:180-182, 243):
   - `creds = getOrgWhatsAppCreds(job.org_id)` per conversation, cached.
   - On `WhatsAppNotConfiguredError` the jobs are marked failed without retries and a system message is written, so there is no retry storm.
5. **Queue fallback message** (queue-db.ts:326-327): the same creds. Skipped if they could not be resolved.
6. **Dashboard text send** (app/api/chat/send/route.ts:17, 43).
7. **Dashboard media send** (send-media/route.ts:33, 79-85).
8. **Dashboard template list** (chat/templates/route.ts:15-19).
9. **Dashboard template send** (send-template/route.ts:37, 64, 88).

   For 6–9:
   - `requireEnvIntegration('whatsapp')` is replaced by `requireWhatsAppIntegration()`, which is `requireOrgContext({ strict: true })` plus `getOrgWhatsAppCreds(access.orgId)`.
   - If there is no integration, it answers 403 with `INTEGRATION_NOT_CONFIGURED_MESSAGE.whatsapp` (lib/settings/org-access.ts:27-32) before any Meta call.
   - The creds are passed down.
   - The template list and template definitions come from the org's registry (2.5), refreshed from Graph with `creds.wabaId`.
10. **AI `schedule_meeting` → sales WA notify** (lib/ai/tools.ts:1040-1061, calling lib/meetings/notify-whatsapp.ts:74-92). `notifySalesWhatsApp({ orgId, ... })` requires all of:
    - the feature `meeting_notify_whatsapp`;
    - recipients from `org_settings.notify_sales_whatsapp` (no longer env `MEETING_NOTIFY_WHATSAPP`);
    - a template from `org_template_bindings('meeting_notify')` that is APPROVED in `whatsapp_templates`;
    - `creds = getOrgWhatsAppCreds(orgId)`.

    If anything is missing it records a `skippedReason` and sends nothing.
11. **Follow-up digest** (lib/followup/digest.ts:80-117, called from app/api/queue/process/route.ts:50-54):
    - Loops over orgs that have the `followup_digest` feature and `org_settings.digest_recipients`.
    - Hour and date use `org_settings.timezone`.
    - Template binding: `followup_digest`.
    - Per-org claim key: `followup_digest_last_sent` in app_settings is already per org since 0061.
    - Creds from `getOrgWhatsAppCreds(orgId)`.
12. **Order payment and cancellation notifications** (app/dashboard/orders/actions.ts:144-161, calling lib/notifications/notifications.ts:51, 75):
    - `isDefaultOrg` is replaced by the feature `order_status_whatsapp` plus `getOrgWhatsAppCreds(orgId)` plus `resolveSendTarget`, which handles BSUIDs (lib/whatsapp/recipient.ts:33-47).
    - These are still free-text messages, so Meta rejects them outside the 24 h window (error 131047) until 4.3 moves them to a template.
13. **Other paths:**
    - `handoff_to_human` sends nothing (unchanged).
    - `generateRAGResponse` makes `orgId` required and drops the default-org fallback (lib/ai/rag.ts:311). Both web-chat routes already pass `orgId` (app/api/chat/route.ts:21-23, app/api/chat/stream/route.ts:53-59).

The non-WhatsApp parts of the same flows (Zoom, invite email, Portal, proposal email) are gated by 2.4; see settings_and_flags.

**Which number sends**

- In the pilot each org has one active `is_default` number, enforced by a partial unique index.
- Sends triggered by an inbound message (1–3) use the receiving number, so the reply always comes from the number the customer wrote to.
- Queue, dashboard and notification sends use the org's default number.
- A second number per org would need `wa_integration_id` on chats and the queue (deferred).

**Health and status**

- A Meta error with code 190 on any send calls `wa_set_health(token_status = 'invalid')`, evicts the cache and logs.
- A daily job on the existing cron calls `GET /{phone_number_id}?fields=verified_name,quality_rating` with the org's creds and updates `token_status`, quality and `last_verified_at`.
- Settings and the onboarding checklist show "Dikelola tim Sarathi" plus status for every org, from `getOrgWhatsAppStatus(orgId)`. It reads only non-secret columns with the service client after `requireOrgContext`.
- This replaces the env and default-org checks in app/dashboard/settings/page.tsx:31-54 and app/api/onboarding/status/route.ts:36-64. No tenant sees webhook URLs or tokens.

**Tests**

- app/api/__tests__/env-integration-gates.test.ts (lines 153-180) becomes integration-gates:
  - the gate runs before the Meta call;
  - creds come from the caller's org;
  - a non-default org without a number gets 403 and Meta is never called.
- The queue-db tests assert `getOrgWhatsAppCreds(job.org_id)`. Today they mock it without arguments (lib/whatsapp/__tests__/queue-db.test.ts:7, 87).
- notify and digest tests: no recipients, no binding or no flag means nothing is sent.
- The GATES set in the route-auth-coverage test adds `requireWhatsAppIntegration` and `requireFeature`.

## Templates and Flows

**Templates (2.5a, independent of D6; data keyed by WABA)**

- **Registry:** `whatsapp_templates`, with org_id, waba_id, meta_template_id, name, language, category, status, quality, components and reason.
- **Sync:** `syncTemplates(orgId)`.
  - Calls `GET /{waba_id}/message_templates?fields=id,name,language,category,status,quality_score,components,rejected_reason&limit=100` and follows `paging.next` until there are no more pages. This fixes the single-page read in templates.ts:48-82.
  - Upserts by (org_id, meta_template_id) and marks templates that have disappeared as DELETED.
  - Runs at onboarding, from a rate-limited "Sinkronkan" action in the dashboard, and after any template webhook that names an unknown template id.
  - A WABA holds at most 250 templates (https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts/).
- **Status webhooks.** They are routed by `entry.id` (the WABA id) inside the verified app; see webhook_routing.
  - `message_template_status_update` updates status and reason.
    - Payload fields: `event`, `message_template_id`, `message_template_name`, `message_template_language`, `reason`, `message_template_category`.
    - `event` is one of APPROVED, ARCHIVED, UNARCHIVED, DELETED, DISABLED, FLAGGED, IN_APPEAL, LIMIT_EXCEEDED, LOCKED, PAUSED, PENDING, REINSTATED, PENDING_DELETION, REJECTED.
    - Fields and events verified at https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update.
  - `message_template_quality_update` updates quality.
  - `template_category_update` updates category.
  - If a template bound to a purpose leaves APPROVED, the handler logs a warning and adds a system notice for the org. The feature skips sends until the template is APPROVED again.
  - Today all these fields fall through unhandled (route.ts:765).
- **Purpose bindings:** `org_template_bindings(org_id, purpose, template_name, language)`, where purpose is meeting_notify, followup_digest or brief_acara.
  - They replace the env vars MEETING_NOTIFY_TEMPLATE/LANG and FOLLOWUP_DIGEST_TEMPLATE/LANG (lib/meetings/notify-whatsapp.ts:82-83, lib/followup/digest.ts:84-85).
  - `sendPurposeTemplate(orgId, purpose, to, variables)` checks, in order: flag ON, binding exists, registry row APPROVED, then gets creds and sends. If any check fails it skips and records the reason.
  - No Sailendra default template names remain anywhere.
- **Sending templates with a FLOW button:**
  - `sendTemplateMessage` builds the FLOW button components from the cached registry components (templates.ts:122-139), instead of one Graph lookup per send (templates.ts:206-213).
  - A cache miss triggers one sync. If the definition still cannot be read, the send is refused instead of failing silently with Meta error 131009.
- **Dashboard picker:**
  - `GET /api/chat/templates` reads the org's APPROVED rows.
  - SendTemplateDialog drops its hint to set WHATSAPP_BUSINESS_ACCOUNT_ID in .env.local (app/dashboard/chats/components/SendTemplateDialog.tsx:217).
- **Creating templates per tenant:**
  - In the pilot the team creates them in the tenant's WhatsApp Manager (UTILITY where possible) and runs sync. Automating `POST /{waba_id}/message_templates` comes later.
  - Templates cannot be copied from Sailendra: template migration only works between WABAs of the same business (https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-migration.md).

**Flows (2.5a)**

- **Registry:** `whatsapp_flows`, with org_id, waba_id, meta_flow_id, name, handler (brief_acara or generic), template_name, flow_json_version and status.
- **How a reply is identified:** Meta's Flow response carries no Flow ID. It has the `flow_token` inside `response_json`, and `context.id` is the wamid of the message that opened the Flow (verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/receiveflowresponse).
- **New flow_token format at send time:** `f1.<whatsapp_flows.id>.<12 random base64url chars>`.
  - Today it is `tpl_<name>_<ts>_<rand>` (templates.ts:128).
  - The Flow is found from the template's FLOW button (registry components) plus `whatsapp_flows.template_name`.
- **Dispatching an nfm_reply.** Parse `response_json.flow_token`:
  - `f1.` token: look up the flow `WHERE id = ... AND org_id = ctx.orgId`, so a token from another org never matches, then run its handler.
  - Legacy `tpl_` token: use the org's flow whose `template_name` matches, then its handler. This keeps Sailendra's already-sent Brief Acara links working.
  - Anything else: the generic handler.
- **Handler brief_acara** (only when the feature `flow_brief_acara` is ON):
  - Today's `handleFlowReply` (lib/whatsapp/flow-response.ts:176-329).
  - The confirmation is built from business_profiles (business name, handoff name) instead of the hard-coded "Tim Sailendra" (flow-response.ts:162-170).
  - Creds come from `ctx`.
- **Handler generic:**
  - Stores the submission as a user message: a "📋 Form WhatsApp" heading with the flattened key/values, keeping `response_json`.
  - Logs a system note.
  - Does not change the lead stage and sends no automatic confirmation.
- **Brief Acara for another tenant (only if D8 allows it):**
  1. Re-create the Flow from docs/flow-brief-acara.json in the tenant's WABA, through WhatsApp Manager or `POST /{waba_id}/flows` (https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowsapi.md).
  2. Publish it.
  3. Create the template with the FLOW button and wait for approval.
  4. Register both.

  Copying a Flow across businesses is unverified; third-party sources disagree. Flow JSON version 7.3 (docs/flow-brief-acara.json:2) must be checked against Meta's current versions before cloning (unverified).

**Seeding Sailendra** (provisioning script, each step approved by the owner):
- Sync its WABA.
- Create the bindings from its current env values.
- Register its v1 and v2 Brief Acara Flows with handler `brief_acara` and the template names from docs/FLOW_BRIEF_ACARA.md:94-103.

## Settings and feature flags

**Per-org settings (2.3, independent of D6)**

- **org_settings:** typed columns (migration org_settings_features) for:
  - timezone and meeting rules;
  - sales notification recipients, WhatsApp and email;
  - email sender display name and reply-to;
  - digest recipients and hour;
  - follow-up thresholds.
- **Access:** members can SELECT their own row. Only the service role writes, because staff could otherwise repoint recipients; roles only arrive in Fase 3 (SAAS_PROGRESS.md:85).
- **Read path:** `getOrgSettings(orgId)`, through the service client and cached for 60 s. A missing row means the column defaults.
- **org_integrations:** one row per provider (zoom | resend | portal), with non-secret config in jsonb and the secret in Vault through `org_integration_put`/`get` (service_role only).
  - **Zoom:** `getZoomConfig(orgId)`. Its token cache is keyed by Zoom account id instead of being one module-level value. Today the config comes from env (lib/zoom/client.ts:19-30).
  - **Portal:** `getPortalConfig(orgId)` (today lib/portal/config.ts:19-29).
  - **Email:** `sendMeetingInvite(orgId, ...)` and the proposal email get the sender from `org_integrations('resend')`, or the env sender for the default org only. The hard-coded sales-inbox fallback goes (lib/meetings/notify.ts:41).
- **Who writes during the pilot:** `scripts/wa-provision.mjs --phase=settings`, following D17: dry-run first, owner approval, then `--confirm`. A tenant self-service UI comes later (3.1, 5.x).

**Feature flags (2.4, independent of D6; D8 decides the values)**

**As built (2026-11-12, owner decision D26: no table yet).** The Sailendra-only features are gated on the default org in code, without a migration:
- the proposal upload, preview and FNA summary routes use `requireEnvIntegration('proposals')`;
- `generateRAGResponse` offers the meeting tools (`check_meeting_availability`, `schedule_meeting`) and their prompt instructions to the default org only, so no other org's AI can create a Zoom room, an invite email or a sales WhatsApp on Sailendra's accounts;
- the Sailendra Portal integration is removed altogether (owner decision D27: Portal and Sarathi are disconnected; the `portal_*` columns stay, no migration).

The proposal email, order notifications and the digest were already default-org only. The `org_features` table below is deferred to Fase 4, when a feature is first opened to a tenant (D8).

**As built (2026-11-14, F10: neutral identity).** What every org can pick or receive no longer carries Sailendra's identity:
- the persona presets (Settings > System Message) are built from the org's business profile (`lib/ai/persona-presets.ts`); client names, prices, venues and capacity come from the org's Knowledge Base. They follow D4 (honest when asked);
- the Knowledge Base templates hold `[ISI: ...]` placeholders instead of Sailendra's name, year, areas and clients;
- the fallback persona (`buildSystemMessage`) and the presets offer an online meeting only when the org can book one (`meetings`, the default org per D26). Otherwise they offer a follow-up with the hand-off contact and promise no meeting or calendar invite. The default org's persona text is unchanged;
- the Brief Acara confirmation, the Pipeline hand-off action (label and `assigned_to`), the proposal intro, the lead-field examples and the profile placeholders use the org's own profile or neutral examples;
- the unused `DEFAULT_BUSINESS_PROFILE` constant is gone (the default org's values are its own row, seeded by 0039).

Inside the default-org-only features (proposal email/PDF, meeting invites) Sailendra's identity stays, as D26 allows. They switch to profile fields when a feature opens to a tenant (Fase 4). The "by Sailendra" credit in the dashboard is D10 (Fase 4).

- **Storage:** `org_features(org_id, feature, enabled)`. A missing row means OFF.
- **Features:**
  - `meeting_tools`: the AI tools check_meeting_availability and schedule_meeting, plus the prompt section about meetings;
  - `zoom_meetings`;
  - `meeting_email`;
  - `meeting_notify_whatsapp`;
  - `followup_digest`;
  - `flow_brief_acara`;
  - `portal_handoff`;
  - `proposal_email`;
  - `proposal_documents`: upload, preview, history and FNA;
  - `order_status_whatsapp`.
- **Seed:** the migration turns every feature ON for the default org (Sailendra), so its behaviour does not change. Other orgs, including the D2 test tenants, stay OFF.
- **Env-binding rule:** `resolveOrgIntegration(orgId, provider)` returns:
  1. the org's `org_integrations` row, if there is one;
  2. otherwise, the env config, but only when `orgId` is the platform default org;
  3. otherwise null.

  So a flag alone can never route another tenant into Sailendra's Zoom, Resend, Portal or WhatsApp accounts. This closes KEA-7 even if a flag is turned on by mistake.
- **Where the flags are checked:**
  - **lib/ai/tools.ts:958-1061** (Zoom room, invite email, sales WA notify): behind `zoom_meetings`, `meeting_email` and `meeting_notify_whatsapp`, plus `resolveOrgIntegration`.
  - **AI tools and prompt:** `buildTools(profile, {features, settings})` drops the meeting tools when `meeting_tools` is OFF (lib/ai/rag.ts:583-597). When `zoom_meetings` is OFF, the prompt promises "link menyusul" instead of a Zoom link (prompt text at rag.ts:439-465).
  - **Flow dispatch (2.5):** behind `flow_brief_acara`.
  - **Digest:** behind `followup_digest`.
  - **Proposals:**
    - upload, preview and fna-summary today require only `requireOrgContext` (upload/route.ts:34, preview/route.ts:22, fna-summary/route.ts:16). They move behind `proposal_documents`.
    - The proposal email (app/api/proposals/[phone]/route.ts:59) moves behind `proposal_email`.
  - **Portal:** `/api/portal/clients`, `handoffToPortal`, and the `portalEnabled` flag in `GET /api/leads` all move behind `portal_handoff`. Today `portalEnabled` is computed from global env (app/api/leads/route.ts:44-46).
  - **Order notifications:** behind `order_status_whatsapp` (orders/actions.ts:144-161).
- **API helpers:**
  - `requireFeature(feature)` is `requireOrgContext({ strict: true })` plus `isFeatureEnabled`. It answers 403 "Fitur ... tidak aktif untuk organisasi ini".
  - Service-role paths call `isFeatureEnabled(orgId, ...)` directly.
  - `requireEnvIntegration` and `isDefaultOrg` are removed once every caller has moved.
- **Client side:** `CurrentOrgProvider` (app/dashboard/layout.tsx:31-37, components/current-org-provider.tsx:13-20) receives `{ timezone, features }`, so menus and buttons can hide: the Portal button, proposal actions, and the meeting UI.
- **What each D8 answer means:**
  - **No:** the flags stay OFF for other tenants.
  - **Yes, for a given feature:** the tenant brings its own resources, never Sailendra's env accounts:
    - its own Zoom server-to-server app, stored in `org_integrations('zoom')`;
    - a sender: either the platform domain ("<Business> via Sarathi", with reply-to set to the tenant) or its own Resend domain;
    - its own approved templates and Flow in its own WABA (2.5);
    - its recipients in `org_settings`.
  - The Portal and the proposal PDF/FNA stay Sailendra-only until 4.2 removes the Sailendra identity (lib/proposals/ProposalDocument.tsx and the SLDR prefix in lib/proposals/ref.ts).
- **Tests (KEA-7 recommendation 7):**
  - A non-default org with every flag ON but no `org_integrations` rows never calls Zoom, Resend, Portal or Meta with env credentials.
  - The default org behaves as before.
  - The tool list and the prompt follow the flags.

**Timezone and meeting rules (2.6, independent of D6)**

- **Columns:**
  - `org_settings.timezone`, limited to Asia/Jakarta, Asia/Makassar and Asia/Jayapura. None of these has daylight saving; their labels are WIB, WITA and WIT.
  - The meeting rule columns.
  - This is also the single home for timezone that 4.1 uses (SAAS_PROGRESS.md:122).
- **lib/meetings/rules.ts:**
  - The constants (rules.ts:5-14) become a `MeetingRules` object.
  - `jakartaParts` becomes `zonedParts(date, tz)`.
  - `jakartaDayRangeUtc` becomes `dayRangeUtc(date, tz)`, without the hard-coded "+07:00" (rules.ts:62-68).
  - `normalizeMeetingIso(raw, tz)` appends the zone's offset (rules.ts:75-80).
  - `validateMeetingWindow`, `validateMeetingDay`, `validateMeetingHorizon` and `isDayFull` take the rules as a parameter.
- **Database:** `reserve_meeting_slot` already receives `p_max`, `p_duration_min`, `p_buffer_min`, `p_day_start` and `p_day_end` (production.txt:301). The code passes the org's values; no SQL change is needed.
- **Places that read the org's rules or timezone:**
  - **Prompt and tool text** (lib/ai/rag.ts:439-465 and 517-529, plus the tool descriptions in lib/ai/tools.ts), generated from the rules: hours, days, max per day, buffer and offset.
  - **Zoom timezone** (tools.ts:975).
  - **Invite and WhatsApp labels** (lib/meetings/notify.ts, notify-whatsapp.ts:61-65).
  - **Dashboard calendar, bookings and order list**, through the provider's timezone.
  - **Follow-up, digest and reports**, in the org's timezone.
- **Duration:** new bookings use `org_settings.meeting_duration_min`. Its default of 40 equals today's env default (tools.ts:1121-1125). Legacy rows with NULL keep the 60-minute display fallback.
- **Tests:**
  - Day ranges for Asia/Makassar and Asia/Jayapura.
  - Normalisation of naive datetimes.
  - Window and day validation.
  - Sailendra's defaults produce exactly today's outputs.

## Rollout (migration plan)

| # | Kind | Step |
|---|---|---|
| 1 | verification | **0. Read-only pre-checks**: (1) whatsapp_integrations has 0 rows. (2) Owner confirms the Easypanel env: WHATSAPP_APP_SECRET is set and WHATSAPP_WEBHOOK_SKIP_SIGNATURE is unset or false (current values unverified). (3) In WhatsApp Manager / the App Dashboard, note Sailendra's meta_app_id, WABA id and every number on that WABA and app. Whether a retired second number is still subscribed is unverified. (4) Read select extversion from pg_extension where extname = 'supabase_vault' (the production version is unverified). (5) Note that 0.2, rotating the leaked WhatsApp token and app secret (SAAS_PROGRESS.md:57), is still open; step 10 takes care of it. |
| 2 | code (no migration) | **1. PR-A: central Graph version (2.7)**: Add lib/whatsapp/graph.ts with GRAPH_API_VERSION = 'v25.0' and use it in client.ts and templates.ts, with URL tests. Merge, the owner deploys in Easypanel, and the new build id is checked. Then run a regression on Sailendra: an inbound text plus the AI reply, a manual text, an image upload and send, a template send with the Brief Acara FLOW button, an inbound media download, and the template list. Rollback: revert the commit. Deadline: before v21.0 stops working on 2027-01-21. |
| 3 | migration (compatible with the live code) | **2. PR-B: migration 0069 lockdown (2.1a)**: Migration plus pgTAP, and the pending lines in expected-diff. Owner review (D1), then apply_migration. Verify: has_table_privilege('authenticated','public.whatsapp_integrations','SELECT') is false, the policy list, and the advisors. Refresh production.txt in the same PR, then merge. No deploy is needed because no code reads the table. |
| 4 | migration (expand) then code | **3. PR-C: webhook hardening on the legacy URL (2.2a)**: Pipeline modules and the Phase-0 AppContext: env secret, default org read strictly, routing map with one number. Also: verify before parse, a loop over every entry/change/message/status, org-scoped writes, idempotency-first ingest, no SKIP flag, and contract tests. Built as part 1 (the gate) and part 2 in three PRs: C1 a pure move into lib/whatsapp/webhook, C2 the atomic ingest (wa_ingest_inbound), C3 durable media and Flow work. The expand migration 0072_wa_inbound_ingest is applied before the C2 deploy (the C1 build never calls it). Deploy each in its own build. Verify: a test message from a team phone is stored once and answered once (also when the same signed bytes are sent twice, scripts/test-webhook.js --repeat=2); a payload for a non-Sailendra phone_number_id, sent with the dashboard Test button, is dropped; there are no signature failures; queue jobs complete. Rollback: revert the build; 0072 stays (an expand). Before a revert of C2, count the rows it marked `metadata.unprocessable` (`select count(*) from public.whatsapp_messages where metadata ? 'unprocessable'`): the older AI history reads them as customer lines (few are expected). |
| 5 | code | **4. PR-D: credential plumbing (2.2b)**: Required WaCreds everywhere. getOrgWhatsAppCreds as an env shim that serves the default org only. requireWhatsAppIntegration in the four chat routes. orgId passed through the queue, notify, digest, orders and RAG. Merge only after PR-C2 is merged and its 48 h watch is clean. Rebase PR-D's own commits onto main, set the PR's base to main, re-run tsc, eslint and vitest (TZ=UTC), squash-merge, and deploy in its own build; confirm the Easypanel build id. Smoke test from a team phone: an inbound text gets one AI reply; a dashboard reply, also quoted; a dashboard photo and document; the template list and the Brief Acara template with its FLOW button, then the Flow confirmation; an inbound photo; a test order set to paid and then cancelled (both customer messages arrive); if MEETING_NOTIFY_WHATSAPP is already set in Easypanel (do not add it for this test: a new value needs a redeploy), let the AI book a meeting in the team phone's WhatsApp chat (the dashboard Test Chat Preview has no schedule_meeting tool), check that sales get the WhatsApp notification, then cancel that booking and its Zoom meeting; if FOLLOWUP_DIGEST_TO is set and there is something to report, the next morning's digest arrives from the same number. Also check that a D2 test-tenant account gets 403 from /api/chat/send without any call to Meta. Rollback: revert PR-D's squash commit and deploy that build, which takes production back to PR-C2. Do not redeploy an older Easypanel build: that would also drop PR-C2. If PR-C2 itself must go too, revert PR-D first, then follow step 3's PR-C2 rollback. There is no migration, no env change and no new dependency, and the rows PR-D writes are inert for the older code. |
| 6 | migration (expand) then code | **5. PR-E: org_settings_features settings and flags, plus the gates (2.4, 2.3)**: Apply org_settings_features first after review: it only adds tables and seeds every Sailendra feature ON. Then merge and deploy the gating code. With the provisioning script and the owner's approval, seed Sailendra's org_settings recipients and template bindings from its current env values. Verify Sailendra end to end in a test chat: booking, Zoom link, invite email, sales WA notify, and a digest tick. Verify on a test tenant: schedule_meeting leaves a pending-link booking and makes no Zoom, email or WhatsApp call (check the logs). This step must be live before any second number is routed. |
| 7 | code | **6. PR-F: timezone and meeting rules (2.6)**: Reads org_settings; Sailendra's defaults stay the same. Verify in a test chat a booking near a WIB boundary, plus the calendar and Bookings views. |
| 8 | migration (expand), code and script | **7. PR-G: wa_templates_flows template and Flow registry (2.5a)**: Apply wa_templates_flows and deploy. Run sync for Sailendra, and register its Brief Acara Flows and template bindings. Verify: the template list; a template send with a FLOW button; an nfm_reply carrying an old 'tpl_' token and one carrying a new 'f1.' token; and a template status webhook updating the registry. |
| 9 | owner decision | **8. D6 decision gate**: The owner confirms Option C and names the legal entity behind the contracts and the privacy policy. Steps 9-16 wait for this; steps 1-7 stand on their own whatever is decided. |
| 10 | migration (compatible with the live code) | **9. PR-H: wa_apps_vault apps and Vault (2.1b)**: Precondition: the table is empty. Review, then apply. Verify: grants, policies, EXECUTE on wa_* granted to service_role only, and the advisors. The Vault round trip is tested only on a local stack; no test rows go into production. Refresh production.txt. |
| 11 | ops script (D17) | **10. Provision Sailendra into Vault (2.1c)**: Run node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<ref>, first --phase=app and then --phase=number, each as a dry-run and then with --confirm after the owner approves. The owner, not Claude, types Sailendra's app secret and System User token into the hidden prompt. A new verify token and the webhook_key are generated and shown once. The number row gets the phone_number_id, the WABA id and the PIN. Recommended: generate a NEW System User token now and stage a new app secret as app_secret_next, which closes 0.2. Then --phase=verify: GET /{phone_number_id} and GET /{waba_id}/subscribed_apps must succeed with the Vault token. Set platform_settings.legacy_webhook_key and wa_creds_source = 'shadow'. |
| 12 | code | **11. PR-I: per-app route and Vault resolver, in shadow mode (2.2c)**: Deploy. In shadow mode, sends still use env, but every resolution also reads Vault and logs whether the two match, comparing hashes only. Verify the build id, and that the new rpc/wa_webhook_app and rpc/wa_send_credentials paths appear in the Supabase API logs. Wait for 24-48 h of matches. Then set platform_settings.wa_creds_source = 'vault' (no deploy) and repeat the smoke tests. Rollback: set it back to 'env' while the env vars still exist. |
| 13 | owner action (Meta App Dashboard) | **12. Owner moves Sailendra's callback URL**: In WhatsApp > Configuration > Edit, set the callback to https://<host>/api/webhook/whatsapp/<key> and the verify token from step 10. Meta's GET check must pass. Subscribed fields stay the same: messages, the template fields, and user_id_update if it is offered. Send a test message and check that it arrived through the per-app route (log line app=<uuid>). If a new app secret was staged: reset the secret in Meta, watch traffic verify with it, then run wa_rotate_secret('app_secret_promote'). |
| 14 | verification | **13. Seven-day soak**: Both URLs accept traffic, on the same pipeline, deduplicated by (org_id, wa_message_id, role). Check daily: hits on the legacy route (must fall to 0 and stay there), signature failures, the unrouted table, queue failures, and token_status. 7 days is Meta's documented maximum retry window. |
| 15 | code, then migration (contract) | **14. PR-J: contract (2.2d) and migration wa_legacy_contract**: Delete the legacy route, the env branch of lib/whatsapp/credentials.ts (envCreds, envWebhookApp, envWhatsAppSendConfigured and the env side of the wa_creds_source switch; the module and getOrgWhatsAppCreds stay, Vault-backed since 2.2c; the app-settings env getters and isWhatsAppConfigured already went in PR-D) and the wa_creds_source switch. Deploy in its own build and verify. Only then apply wa_legacy_contract, which drops verify_webhook_token and the platform verify-token keys, and refresh the fingerprint. The owner removes the WHATSAPP_* env vars from Easypanel. One contract per build (supabase/README.md:376-384). |
| 16 | verification and rehearsal | **15. Tenant-2 gate**: All of these must hold: 0067 (chat-media private) is live (SAAS_PROGRESS.md:153); steps 1-14 are done; the Sailendra-only flags are OFF for the new tenant; the two-org contract tests are green. Then rehearse the onboarding runbook end to end, using a D2 test tenant and a Meta test number in a team-owned test portfolio, and remove them afterwards. |
| 17 | ops runbook | **16. Onboarding tenant #2 (done by the Sarathi team)**: (a) Paperwork: signed agreement, DPA, and written authorization for named team members to administer the client's Meta assets (3.8, counsel). (b) Client prerequisites: its own Meta Business portfolio (business verification recommended); a number not active on WhatsApp or the WhatsApp Business app; a payment method on the WABA. (c) The client adds a named team member to its portfolio with access to the app and the WABA. Never shared passwords. (d) In the client's portfolio, the team creates a Business-type app with the WhatsApp product, creates or links the WABA, adds and verifies the number, requests the display name, and sets the 2FA PIN. (e) The team creates an admin System User, assigns it the app and the WABA, and generates a token with whatsapp_business_messaging and whatsapp_business_management. (f) App settings: privacy policy URL, icon, category, Live mode, and default API version v25.0. (g) Create the org (3.1 or a service script), then run wa-provision --phase=app (secrets typed into the hidden prompt; webhook_key and verify token shown once), --phase=number, and --phase=verify (token_status must become valid). (h) In the app's WhatsApp > Configuration: set the callback URL with the key and the verify token. Subscribe messages, message_template_status_update, message_template_quality_update, template_category_update, account_update, and user_id_update if offered. Then call POST /{waba_id}/subscribed_apps and confirm with a GET. (i) Create the templates D8 allows in the tenant's WhatsApp Manager, wait for approval, then run --phase=sync and bind the purposes. Flows only if D8 allows them. (j) Use --phase=settings for timezone, rules and recipients, and turn on only the flags D8 allows. (k) The tenant fills in its business profile, persona and knowledge base. (l) Smoke test: a message from a team phone appears only in the tenant's inbox (count rows per org); the AI reply comes from the tenant's number; statuses arrive; a template send works; the unrouted table is empty; Sailendra is unaffected. (m) Go live, add a tracker entry, and turn on daily monitoring. |

## Tasks

| ID | Size | Needs D6 | Task | Detail |
|---|---|---|---|---|
| 2.7 | S | no | Central Graph API version, raised to v25.0 | New lib/whatsapp/graph.ts with GRAPH_API_VERSION = 'v25.0', graphUrl(path, version?) and graphFetch(creds, path, init) (cache 'no-store', errors through makeWhatsAppApiError). Delete the two v21.0 constants (lib/whatsapp/client.ts:5, lib/whatsapp/templates.ts:10). The version comes from creds.graphVersion, later whatsapp_apps.graph_api_version or the default. Unit tests pin every URL: messages, media upload, media GET with phone_number_id, and message_templates. Make the User-Agent neutral (client.ts:305). Run a regression on Sailendra after deploy, and the owner sets Sailendra's app default version in the dashboard. Done in PR #56 except graphFetch and the media GET's phone_number_id; the version per credential followed in PR-D (2.2b). graphFetch with appsecret_proof comes with 2.2c; phone_number_id on the media GET waits for a check on a test number (2.9 rehearsal; see Send paths, As built (PR-D)). v25.0 is supported until 2028-07-29; v26.0 is newer but has no announced end date (https://developers.facebook.com/docs/graph-api/changelog/versions). Must ship before 2027-01-21. |
| 2.1a | S | no | Lock down whatsapp_integrations now (migration 0069) | Precondition: 0 rows. Drop the member FOR ALL policy (production.txt:464). Revoke all from anon and authenticated (today authenticated has rawdDxt, :549). Add the 'service_role only' deny policy, as on message_queue and rate_limits (:452, :460). pgTAP: 010 stops treating the table as member-CRUD (010:138-141, :212) and asserts a new tests.check_role_denied for members. Compatible with the live code because nothing reads the table. This closes the hole where any member can claim a phone_number_id, which must happen before 2.2 routes by number. |
| 2.2a | L | no | Webhook pipeline hardening on the current URL (fail-closed, still one env app) | Move the logic into lib/whatsapp/webhook/* (verify, router, ingest, handlers) so 2.2c can reuse it. Verify the HMAC over raw bytes before JSON.parse (today route.ts:314, 326, 355-366). Delete WHATSAPP_WEBHOOK_SKIP_SIGNATURE (route.ts:319-320, .env.example:42). Remove the anon-key fallback (route.ts:334-337). Read the default org strictly, with no seed fallback on error (org-context.ts:72-74). Loop over every entry, change, message and status (today entry[0].changes[0] and messages[0], route.ts:343, 453-455). Use a one-number routing map built from the env phone_number_id and WABA id; drop other numbers and log a hash of the id. Add org_id to the status update and the media dedup (route.ts:436-439, 183-188). Ingest idempotency-first (chat row ensured, message row as the gate, side effects only for new rows) so a late Meta retry after the 24 h queue prune cannot double-reply. Match contacts per message. Answer 503 only for retryable errors; answer 200 for non-WABA objects (today 404, route.ts:766-769). Handle user_changed_user_id (shape unverified). Contract tests as listed in webhook_routing. |
| 2.2b | M | no | Credential plumbing: required WaCreds on every send path, one resolver | WaCreds type. client.ts and templates.ts require creds and lose their env fallbacks (client.ts:74-75, 176-177, 214-215, 278; templates.ts:56-57, 97-98, 192-193). The media GET passes phone_number_id. getOrgWhatsAppCreds(orgId) and getIntegrationCreds(id), with a Phase-0 env shim that serves the default org only and throws WhatsAppNotConfiguredError for others. requireWhatsAppIntegration() replaces requireEnvIntegration('whatsapp') in chat/send, send-media, send-template and templates. The queue resolves creds from the job's org (queue-db.ts:182). orgId is passed into notify-whatsapp, digest, orders and notifications. rag.ts:311 drops the default-org fallback. Tests: integration gates, queue creds per org, and a static test that no WHATSAPP_* env var is read outside the shim. Built in PR-D (2026-10-31); deviations are listed under Send paths, 'As built (PR-D)'. |
| 2.4 | M | no | Per-org feature flags and gates for Sailendra-owned integrations (KEA-7) | org_features table (in org_settings_features): members can read, only the service role writes. Every feature is seeded ON for the default org, so Sailendra is unchanged, and OFF for everyone else. isFeatureEnabled and requireFeature, with a 60 s cache. resolveOrgIntegration uses env Zoom, Resend or Portal only for the default org, or an org_integrations row. Gates: schedule_meeting's Zoom, email and WA notify (tools.ts:958-1061); meeting tools and prompt copy (rag.ts:583-597); Flow handler; digest; proposal upload, preview, FNA and email; Portal routes and the portalEnabled flag (leads/route.ts:44-46); order WA (orders/actions.ts:144-161). Flags reach CurrentOrgProvider for the UI. Tests: a non-default org never reaches env integrations. Must be deployed before any second number is routed (2.2c). |
| 2.3 | L | no | Per-org settings, notifications, digest and integration secrets (org_settings, org_integrations) | org_settings (typed; members read-only) and org_integrations (Zoom, Resend, Portal config, with the secret in Vault through service_role-only RPCs), both in org_settings_features. getOrgSettings with a cache. Zoom client per org, with its token cache keyed by account. Email sender per org: Sailendra keeps the env sender through the default-org binding; others stay OFF until there is a platform domain or their own Resend domain. Remove the hard-coded Sailendra sales-inbox fallback (lib/meetings/notify.ts:41). Meeting notify reads the org's recipients. The digest loops over orgs, with per-org recipients, hour, timezone, template and creds (digest.ts:80-117). Provisioning-script phase 'settings' to seed Sailendra from its current env. No tenant UI in the pilot; the platform-admin UI is 3.1. |
| 2.6 | L | no | Timezone and meeting rules per org | org_settings.timezone (Asia/Jakarta, Asia/Makassar or Asia/Jayapura) and the rule columns. rules.ts is parameterised: zonedParts, dayRangeUtc and normalizeMeetingIso take the timezone; the rules object replaces the constants (rules.ts:5-14, 62-80). reserve_meeting_slot gets the org's values (its parameters already exist, production.txt:301). Prompt and tool text are generated from the rules (rag.ts:439-465, 517-529). Zoom timezone (tools.ts:975). Email and WA labels. Dashboard calendar, bookings and orders through the provider. Follow-up, digest and reports. The duration is unified (default 40; legacy NULL rows shown as 60). Tests for WITA and WIT. Sailendra's defaults are unchanged. This is also the timezone home for 4.1. |
| 2.5a | L | no | Template and Flow registry per WABA, plus the template status handler | wa_templates_flows: whatsapp_templates, org_template_bindings and whatsapp_flows. Paginated sync (fixes templates.ts:48-82). Handlers for template status, quality and category webhooks, routed by entry.id (verified fields in the Meta reference). sendPurposeTemplate fails closed when the binding is missing or the template is not APPROVED. FLOW button components come from the cached definition (no Graph lookup per send, templates.ts:206-213). flow_token format 'f1.<flow id>.<nonce>', with a fallback for Sailendra's legacy 'tpl_' tokens. nfm_reply dispatch by handler; Brief Acara confirmation built from business_profiles (flow-response.ts:162-170); a generic handler for unknown Flows. Fix the dialog hint (SendTemplateDialog.tsx:217). Seed Sailendra's registry, bindings and Flows. |
| 2.1b | M | yes | Option C schema: whatsapp_apps, reshaped numbers table, Vault RPCs (migration wa_apps_vault) | whatsapp_apps (per-app secret ids, webhook_key and previous key, verify-token hash, version, status, token_status). whatsapp_integrations reshaped: id PK, composite FK (app_id, org_id), PIN in Vault, is_default with a partial unique index, status and health columns, redundant index dropped, org FK changed to RESTRICT. whatsapp_webhook_unrouted. Service_role-only SECURITY DEFINER RPCs: wa_provision_app, wa_provision_number, wa_rotate_secret, wa_set_status, wa_set_health, wa_webhook_app, wa_send_credentials, wa_note_unrouted, wa_offboard_org. New pgTAP file 190, additions to 050, and two entries in the guard-13 allowlist. Precondition: the table is empty. |
| 2.1c | M | yes | Provisioning, rotation and health tooling, plus the tenant status view | scripts/wa-provision.mjs, plus scripts/lib with tests, following the D17 conventions: dry-run, --confirm, --expect-ref, secrets only through a hidden TTY prompt typed by a human. Phases: plan, app, number, verify (GET /{phone_number_id}), subscribe (POST/GET /{waba_id}/subscribed_apps), sync, settings, rotate (stage the next app secret, then promote; token, PIN, verify token, webhook key), status, offboard. A daily health job on the existing cron sets token_status, quality and last_verified_at. Settings and onboarding show a masked status for every org from DB columns that are not secret (replacing page.tsx:31-54 and onboarding/status/route.ts:36-64); no tenant sees webhook values. |
| 2.2c | M | yes | Per-app webhook route and Vault-backed credentials (shadow, then flip) | app/api/webhook/whatsapp/[key]/route.ts (GET and POST) on the 2.2a pipeline. AppContext comes from wa_webhook_app, with positive and negative caches. The routing map is filtered by app_id. Unknown ids are recorded through wa_note_unrouted. Two secrets are accepted during a rotation. The legacy route is bound to platform_settings.legacy_webhook_key. The resolver supports wa_creds_source = env \| shadow \| vault, and shadow mode logs only hash comparisons. Update the route-auth-coverage EXEMPT list. Add tests for cross-app injection and unknown keys. |
| 2.2d | S | yes | Sailendra cutover, legacy route removal, contract wa_legacy_contract | The owner moves Sailendra's callback URL and verify token to the per-app URL. A 7-day soak follows, with both URLs live. Then remove the legacy route and the env branch of lib/whatsapp/credentials.ts (the module stays; the app-settings env getters went in 2.2b), deploy alone, apply wa_legacy_contract (drop verify_webhook_token and the platform verify keys), refresh the fingerprint, and remove the WHATSAPP_* vars from Easypanel. The 0.2 rotation is finished by provisioning the rotated secrets straight into Vault. |
| 2.8 | S | yes | Meta Tech Provider registration: not required under C, deferred to 5.4 | Under C each client app is a direct-developer app, which needs no Advanced access and no App Review (https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review.md). Update the tracker row to 'not needed for the pilot'. Prerequisites if it is pursued for 5.4 (self-serve, coexistence): a verified Sarathi legal entity (D6), a privacy policy (3.8), App Review videos including template creation (needs a create-template feature), and Embedded Signup v4. Whether Meta accepts a team running many client apps as 'direct developer' over the long term is unverified, so ask counsel or Meta. |
| 2.9 | M | yes | Tenant onboarding runbook and rehearsal (tenant-2 gate) | docs/RUNBOOK_WA_TENANT_ONBOARDING.md, replacing the historical docs/ONBOARDING_EO.md:3-5, 26-46. It covers the onboarding steps in migration_plan step 16, offboarding (wa_offboard_org, removing team members from the portfolio, data export as in 5.3), and rotation. Rehearse the whole runbook with a D2 test tenant and a Meta test number in a team-owned test portfolio before any real tenant. Gate checks: 0067 is live, two-org contract tests are green, Sailendra-only flags are OFF for the tenant. |
| 2.10 | S | no | Docs and comments that match the code | docs/SAAS_ROADMAP.md:49-50 and :69 describe per-number routing and per-tenant signatures as done; they are not. Fix the route comments that claim per-org secret selection (route.ts:322-325, 352-354) and queue-db.ts:180-181. Update the supabase/README.md guard-13 list and document the new test helpers. Update the WhatsApp section of .env.example. Update tracker rows 2.1-2.8 as each PR lands. |

## Risks

| Risk | Mitigation |
|---|---|
| Sailendra regresses during the cutover. It is live and is tenant #1. | Each step deploys alone with a smoke test. Schema steps only add until the contract. Shadow mode logs whether env and Vault match before wa_creds_source is flipped. The legacy URL stays up for 7 days. Rollback is flipping the switch back or reverting a build. Contracts are applied only after the deploy is verified (supabase/README.md:344-384). |
| Secrets are exposed: plaintext columns, logs, backups, shell history, or Claude's context. | Vault behind service_role-only RPCs; pgTAP asserts no secret columns remain. RPC calls are parameterised, and Supabase's default log_statement is ddl, which must never be raised (https://supabase.com/docs/guides/database/postgres/postgres-log-config). Secrets are typed by the owner into a hidden prompt, never passed as CLI args or files in the repo. Logs carry uuids only. Whether Supabase API logs keep RPC request bodies is unverified, so rotate if exposure is suspected. |
| Under C the tenant owns its Meta app and can read its own app secret and token, so it could forge webhooks. | A forged webhook can only reach the tenant's own org: apps are bound to one org by the composite FK and routing is per app. Sends from its own number are the tenant's own business. Sarathi never keeps another tenant's number under that app. |
| A wrong or rotated app secret produces 401s. Meta retries for 36 h to 7 days (its documents disagree) and then drops the events. | Stage the next secret and accept both during a rotation. Alert on signature failures per app. Fixed runbook order: stage, reset in Meta, verify, promote. |
| Events for numbers that were never provisioned are lost without notice. | whatsapp_webhook_unrouted counter with a daily alert. In the runbook, provisioning always comes before the webhook configuration. |
| Some Meta facts are unverified: entry.id as the WABA id for message fields, how webhook payload versions are chosen per app, the exact Live-mode requirements, and whether user_id_update can be subscribed. | For message fields the router trusts phone_number_id and treats a WABA mismatch as unrouted, which is visible. A per-app version checklist. Verify each point in the step 15 rehearsal before tenant #2. |
| Policy and legal: the team operates apps inside clients' portfolios, and Meta's terms have an AI-provider clause (section 4.7). | Written authorization and a DPA from each client. Named team members with least privilege, removed at offboarding. Counsel reviews the terms (https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform). Fallback: become a Tech Provider and use Embedded Signup (5.4). |
| No coexistence, so a client's number must leave the WhatsApp Business app. WABAs created through developer apps cannot be selected in Embedded Signup later, which adds migration cost if the platform moves to Option B. | Tell pilot clients before they sign and suggest a dedicated number. Decide D6 with the 5.4 migration cost in mind. Keep the pipeline independent of the app model, since routing is already per entry. |
| With N apps, settings drift: Graph version, webhook fields, Live mode, token validity. | A central default version plus a per-app graph_api_version. A daily health job for token_status and quality. A quarterly checklist per app. One runbook. |
| Duplicate or late webhook deliveries: Meta retries for up to 7 days, and both URLs are live during the cutover. | The message row, unique on (org_id, wa_message_id, role), is the gate before any side effect. The queue's dedup index, pruned after 24 h, is no longer the only guard. |
| A batch of up to 1000 updates is slow to process and times out. Meta's timeout is unverified. | The AI runs through the queue, media is downloaded after the row exists, each change has its own try/catch, and 503 is returned only for retryable errors. If latency grows, persist first and process later (3.7). |
| A flag is set by mistake and routes a tenant's data into Sailendra's accounts (KEA-7). | Env-bound integrations also require the default org. Only the service role can write flags. Tests check that a non-default org with every flag ON never uses env credentials. |
| Vault secrets cannot be decrypted after a restore into a new project, because the root key differs. | The 0.15 restore drill must include decrypting a Vault secret. The owner stores the project root key as Supabase documents (https://supabase.com/docs/guides/database/vault). |
| The webhook key leaks through proxy logs or screenshots. | It is not a secret by design; every request still needs a valid HMAC. Rotate it with wa_rotate_secret('webhook_key'), which keeps the previous key valid for 7 days while the dashboard URL is changed. |
| Member roles are not enforced yet (KEA-17 moved to Fase 3), so staff could change sensitive configuration. | Every WhatsApp, settings and flag table is read-only or invisible to members. Writes go only through the service role and the team script. |
| A template is missing or paused in a tenant's WABA, and the feature fails without anyone noticing. | Purpose bindings fail closed and record a skip reason. Registry status is shown in Settings and kept current by status webhooks. Template creation is on the onboarding checklist. |

## Adversarial critique (part of the plan)

Revise before starting. I found 0 blockers, 6 major and 7 minor issues.

**What holds up.** Tenant isolation is sound. The URL key picks the app secret. The HMAC is checked over the raw bytes before anything is parsed. Routing only considers the numbers that belong to the app that verified the request. A composite foreign key ties each app to exactly one org. Status updates and media dedup now filter on org_id. Every fallback to env or to the default org is removed. I found no path for tenant A's webhook, token, template or setting to reach tenant B. The design's claims about the current code match this branch: app/api/webhook/whatsapp/route.ts:314, :326, :343, :436-439, :453-455; lib/whatsapp/credentials.ts:19-41; supabase/fingerprint/production.txt:444, :464, :549.

**What needs fixing:**
1. **Lost AI replies on retry.** The webhook writes the message row before anything else. If a later step fails (queueing the AI reply, the Flow handler), the design answers 503 and Meta resends. The resend hits the existing row and stops, so the AI reply or Flow confirmation never happens. Today this error path recovers through Meta's retry.
2. **Step order.** Step 5 seeds and checks template bindings that only exist after migration wa_templates_flows in step 7. Until then, Sailendra's sales WhatsApp alert and digest can stop without any error.
3. **Unchecked WABA id.** In Phase 0, every inbound message and every send depends on the env WHATSAPP_BUSINESS_ACCOUNT_ID, and nothing checks it beforehand. If it is wrong, messages are dropped with a 200.
4. **Leaked credentials.** The leaked app secret and token are still live (tracker 0.2), and the design only rotates them after D6. The plan to stage the new secret first does not work: Meta creates the new secret at reset time. Rotating in step 10 also defeats step 11's env-vs-Vault comparison.
5. **No alerting.** Every path that drops events on purpose relies on alerts, and the repo has none.
6. **Cost abuse under Option C.** Anyone at the client who can read the app secret can forge signed webhooks. Each forged message burns the platform's OpenAI budget, and there is no per-org quota before tenant 2.

Most of Meta's platform facts are stated correctly. The design gets the rotation order wrong. Webhook payload versioning and Meta's app-secret reset behaviour are unverified.

Not covered here: the user's question about turning Realtime "Allow public access" on through MCP. This read-only review made no Supabase or MCP calls.

| Severity | Issue | Fix |
|---|---|---|
| major | Writing the message row first loses side effects when Meta resends. In webhook_routing step 9, the whatsapp_messages row is inserted first, and the other work runs only 'for a new row'. Step 10 answers 503 on any retryable failure and relies on step 9.3 to dedup the resend. If the failure comes after the insert (queueing the AI reply, updating the chat summary, the Flow confirmation, the rate-limit warning), the resend hits 23505 on uniq_whatsapp_messages_org_wamid (supabase/fingerprint/production.txt:444) and stops, so the AI reply is never queued. Today the same transient queue error reaches the outer catch and returns 500 (app/api/webhook/whatsapp/route.ts:645, 771-773; lib/whatsapp/queue-db.ts:76-91), and Meta's retry queues it again. For the live tenant, the design turns a path that currently recovers on its own into a permanent loss. | Do the chat-row upsert, the message insert and the queue insert in one transaction: a service_role-only RPC that reports whether the row is new or a duplicate. Alternatively, store an ingest state on the row and, on 23505, finish whatever work was left undone instead of stopping. Push and unread count can stay best-effort. Add a contract test: queueing fails once → 503 → resend → exactly one queue job and one reply. |
| major | The rollout steps are out of order. migration_plan step 5 (PR-E, migration org_settings_features) seeds Sailendra's 'template bindings' and checks 'sales WA notify and a digest tick'. send_paths 10-11 require an org_template_bindings row and an APPROVED whatsapp_templates row. Both tables only arrive with migration wa_templates_flows in step 7 (PR-G). Today both features take their template names from env (lib/meetings/notify-whatsapp.ts:76-83; lib/followup/digest.ts:81-85). Between PR-E and PR-G plus the registry sync, Sailendra's sales WhatsApp alert and daily digest either cannot be configured or are skipped with a recorded reason, which by design raises no error. | Land wa_templates_flows and Sailendra's registry sync before the PR that rewires notify and digest, or in the same PR. Otherwise keep the env template names as a fallback limited to the default org until 2.5a is live. After each PR, check that Sailendra's notify and digest still send. |
| major | Phase 0 makes env WHATSAPP_BUSINESS_ACCOUNT_ID load-bearing, and nothing checks it first. On the legacy route, the one-number routing map treats any change whose entry.id differs from the env WABA as unroutable and answers 200. The event is lost, and there is no unrouted table before wa_apps_vault. WaCreds makes wabaId required, so the env shim needs it for every send. If the shim treats a missing WABA as 'not configured', every AI reply fails, and those jobs are not retried. Today the variable is only used for templates (lib/settings/app-settings.ts:162-165; lib/whatsapp/templates.ts:56-57). Its production value is unverified, and step 0 only 'notes' the WABA id. | In step 0, confirm that the env WABA owns the env phone_number_id (GET /{waba_id}/phone_numbers) and that the app appears in GET /{waba_id}/subscribed_apps. Run the new router in log-only 'would drop' mode for a day before it starts dropping. In Phase 0, route message fields by phone_number_id alone, since the signature already ties the request to the app, and do not require wabaId for message sends. Add the same checks to wa-provision --phase=verify. |
| major | The leaked credentials stay active, and the rotation plan cannot be carried out as written. Tracker 0.2 says the leaked WhatsApp System User token and App Secret are the ones in use now (docs/SAAS_PROGRESS.md:57). The design only closes 0.2 at step 10, after the D6 decision and migration wa_apps_vault, so until then invariant I1 ('trust comes only from the signature') gives Sailendra no protection. Step 10's 'stage a new app secret as app_secret_next' cannot happen before the secret is reset in Meta, because the reset is what creates the new secret. The risk table's order 'stage, reset, verify, promote' is therefore wrong. Whether the old secret keeps working for a grace period, and whether a reset also revokes tokens, are both unverified. Putting a NEW token and secret into Vault while env still holds the old ones means step 11's '24-48 h of env-vs-Vault matches' can never happen. Revoking the leaked token would also break sends in shadow mode, which still use env. | Do 0.2 now, outside Fase 2. The owner resets the app secret in Meta, creates a new System User token, updates the env in Easypanel and redeploys; Meta's retries cover the brief window of 403s. Then he revokes the old token. Later, load these already-rotated values into Vault, so the shadow comparison actually tests something. Rewrite the rotation runbook in this order: reset in Meta → immediately stage the new value as the next secret → watch signatures verify → promote. |
| major | Every path that drops events on purpose depends on alerting that does not exist. These are all permanent losses: an unknown number or WABA (200, dropped), a suspended app (200), a WABA mismatch, and 401s that outlast Meta's retry window (36 h in one Meta doc, 7 days in another). The design expects to catch them through 'ops reads whatsapp_webhook_unrouted daily', 'alert on signature failures per app', and a daily health job. The repo has no error-monitoring dependency and no alert channel: nothing in package.json, and tracker 3.5 still lists error monitoring as open (docs/SAAS_PROGRESS.md:112). The tenant-2 gate in step 15 does not require one either. A small team will not reliably check a table every day. | Add a minimal alert channel to the tenant-2 gate. For example, the existing every-minute cron can send the ops team a push, email or WhatsApp-template digest whenever unrouted hits, signature failures, 503s, a token_status other than valid, or failed queue jobs are non-zero. Plan for the 36 h retry figure. Keep signed changes that could not be routed in quarantine (minimal fields, at most 7 days) so a provisioning mistake can be replayed. |
| major | Under C, anyone at the client who can read the app secret can forge signed webhooks, and the design's threat model treats that as harmless. The risk table says a forged webhook can only reach the tenant's own org. That is true for isolation. But each forged text message is stored, queued and answered using the platform's OpenAI key (D7 is still pending). The only throttle is per org and contact, 10 per minute (lib/whatsapp/rate-limiter-db.ts:10-11; app/api/webhook/whatsapp/route.ts:619), so forging a different `from` on each message gets around it. Replies to the fake numbers fail at Meta only after the AI cost has been paid. wa_note_unrouted also writes one row per distinct forged id, so that table can grow without limit. Per-org quotas are planned as task 3.4 (docs/SAAS_PROGRESS.md:111) but are not part of the tenant-2 gate. | Before tenant 2, add per-org and per-app caps: inbound messages per minute, and AI jobs and tokens per day, each with a hard stop and an alert (a minimal version of 3.4). Cap the number of distinct unrouted ids recorded per app per day. Update the threat model: the tenant holds its own signing key. |
| minor | Late or out-of-order resends corrupt state, and the 503 retry design makes them more frequent. The chat summary sets last_inbound_at and last_message to the current time (app/api/webhook/whatsapp/route.ts:676-683), and messages get created_at = now() (supabase/fingerprint/production.txt:197). A batch resent hours later reopens the 24-hour reply window in the UI (app/dashboard/chats/components/ChatWindow.tsx:57-59, 533; ChatList.tsx:280). It also lands out of order in the AI's history, which is sorted by created_at (lib/whatsapp/queue-db.ts:208-214). Status updates only ever overwrite (route.ts:436-439), so a resent 'delivered' can replace 'read'. | Use the timestamps Meta puts in the payload (messages[].timestamp and statuses[].timestamp). Only move last_inbound_at forward (GREATEST), set created_at from Meta's timestamp, and only let a status advance (sent < delivered < read, with failed handled separately). |
| minor | Blocking sends on token_status can cause an outage of the team's own making. getOrgWhatsAppCreds throws when token_status is invalid. Any Meta error 190 sets it to invalid, the queue then fails the jobs without retrying, and only the daily health job resets it. During a token rotation, the 60-second credentials cache still serves the old token. That produces a 190 and blocks the org for up to 24 h, even though the new token is already in Vault. The design does not say that wa_rotate_secret('access_token') resets token_status. It also does not separate transient Vault or RPC errors during the lookup from 'not configured'. | Treat token_status as a hint, not a gate, and let the send itself fail. On a 190, re-check the current token in Vault right away. Reset token_status whenever the token is rotated. Treat Vault and RPC errors as retryable: 503 on the webhook, retry in the queue. |
| minor | The design says one number per org is enforced, but it is not. The partial unique index whatsapp_integrations_org_default_key only limits each org to one is_default row, so wa_provision_number(p_is_default=false) can still add a second number. Inbound messages to that second number are routed to the org. Replies from the queue and the dashboard, however, go through getOrgWhatsAppCreds(org), which is the default number. Chats are keyed by (org_id, phone_number) (supabase/fingerprint/production.txt:268). The customer therefore gets the reply from a different number, or the send fails with 131047. | Until wa_integration_id is added to chats and the queue, add UNIQUE(org_id) to whatsapp_integrations, or make wa_provision_number refuse a second number for an org. |
| minor | The wa_apps_vault SQL has two gaps. First, a comment says the org foreign key changes from CASCADE to RESTRICT, but no statement drops and re-adds whatsapp_integrations_org_id_fkey (supabase/fingerprint/production.txt:270). Deleting an org would still delete its number rows and leave their Vault secrets orphaned. Second, Vault secret names are unique. After app_secret_promote, the promoted secret keeps the name 'wa_app:<id>:app_secret_next', so the next time a secret is staged under that name the insert fails. | Add the statements that drop and re-add the foreign key. On promote, rename the secret with vault.update_secret, or put a version number or uuid in secret names. Cover both cases in pgTAP test 190. |
| minor | The secret-handling rules collide with decisions D17 and D1. Under D17, Claude runs service-role scripts on the owner's machine (docs/SAAS_PROGRESS.md:33). Claude's shell is non-interactive, so the hidden terminal prompt for secrets cannot work there. That pushes people toward the fallback the design forbids: pasting secrets into chat or passing them as command-line arguments. Under D1, Claude also verifies production with Supabase MCP SQL. That SQL can read vault.decrypted_secrets or call wa_webhook_app, wa_send_credentials and org_integration_get, and no rule keeps secrets from reaching Claude's context that way. Separately, shadow mode logs hashes of the secrets when a match/no-match flag would be enough. | Make an explicit exception to D17: the owner runs the phases that take secrets (app, number, rotate) in his own terminal, and Claude runs only the phases that do not. Add a rule, with a fixed set of verification queries, that MCP never selects decrypted secrets or calls a function that returns them; checks look only at ids, counts and booleans. Log only whether the values match. Never include RPC inputs in RAISE messages. |
| minor | graphFetch does not send appsecret_proof. Under C the client owns the app and can switch on 'Require App Secret'. From then on, every Graph call without appsecret_proof fails (https://developers.facebook.com/docs/graph-api/securing-requests), so all of that tenant's sends would stop at once. Sarathi already holds the app secret, so it could always send the proof. Doing so also means a leaked token is useless on its own. | Have graphFetch add appsecret_proof = HMAC-SHA256(access token, app secret) to every call. Switch on 'Require App Secret' for each client app during onboarding. |
| minor | Account and number health events are subscribed to but ignored. The runbook subscribes account_update, and the router classifies phone_number_quality_update, but the dispatcher sends anything it does not recognise to a debug log line. A ban, a restriction or a change in messaging limits is only noticed by the daily quality check, if at all. | Handle account_update and phone_number_quality_update: update state with wa_set_status or wa_set_health and raise an alert. Add both to the contract tests. |

Missing from the design (to cover while implementing):

- Quarantine and replay for signed changes that cannot be routed (minimal fields, kept at most 7 days), so a provisioning or WABA-id mistake can be recovered instead of lost by design.
- wa-provision --phase=verify and the daily health job should check that phone_number_id appears in GET /{waba_id}/phone_numbers and that this meta_app_id appears in GET /{waba_id}/subscribed_apps. Today they only check that the calls succeed.
- Additions to the tenant-2 gate: 0.2 rotation done; minimal alerting (3.5); minimal per-org quotas (3.4); privacy policy and DPA (3.8). Each client app needs a privacy policy URL before it can go Live.
- Defined failure behaviour (503 or throw) when platform_settings.wa_creds_source or legacy_webhook_key cannot be read. Today getPlatformSetting turns any read error into null (lib/settings/platform-settings.ts:47-50).
- A sweeper for media rows left with media_url = null when the process restarts after answering 200. Meta media ids can only be downloaded for 7 days.
- Tie the env Zoom, Resend and Portal credentials explicitly to Sailendra, or move them into org_integrations, rather than to whichever org default_org_id names. getDefaultOrgId still falls back to the seed org on a read error (lib/settings/org-context.ts:72-74).
- import 'server-only' in the new credentials, graph and Vault modules. The package is not used anywhere in the repo today.
- A per-app checklist item for webhook field versions in the App Dashboard. It is unverified whether the app's default API version controls the version of webhook payloads.
- Operations for Sarathi staff turnover: removing a departing team member from every client portfolio. There is also a conflict with least privilege, because creating an admin system user needs full control of the client's portfolio.
- Contract tests for: a queueing failure → 503 → resend producing exactly one job; a late resend leaving last_inbound_at and status unchanged; Sailendra's notify and digest still sending after each PR from A to G.
- A re-baselined schedule. The design's own sizes (4 L, 6 M, 5 S) come to roughly 35-70 dev-days. With one owner reviewing everything (D1), manual deploys and the shadow and soak windows, that is closer to 2-3 months than the tracker's 2-3 weeks (docs/SAAS_PROGRESS.md:91). If D6 = B, the Meta lead time for 2.8 (business verification plus App Review, whose video needs a template-creation feature) becomes the critical path.

## Meta requirements

**What Option C needs from Meta, per tenant.** Everything lives inside the client's own Business portfolio. Sarathi does not need Meta business verification or App Review of its own.

1. **A Business portfolio owned by the client.**
   - Business verification is optional to start but recommended.
   - New portfolios start at 250 unique users per 24 h and 2 registered numbers. Verification raises these to 2,000 and 20.
     - https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits.md
     - https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers.md
   - Limits and BSUIDs are per portfolio, so each client keeps its own.

2. **A Business-type app with the WhatsApp product**, created by the team inside that portfolio.
   - Direct-developer use needs no Advanced access and no App Review. Meta: "if you are using the API for yourself as a Direct Developer, you do not need Advanced access or app review" (https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review.md).
   - Unverified: whether Meta still treats this as direct-developer use when one team runs many clients' apps over the long term. This belongs to D6, to check with counsel or Meta.

3. **A WABA and phone number in the client's portfolio.**
   - The number must not be active on WhatsApp or the WhatsApp Business app. Keeping both (coexistence) needs Embedded Signup by a Tech Provider or Solution Partner (https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users.md).
   - The display name must be approved.
   - A 2FA PIN must be set; Sarathi keeps it in Vault.
   - The client attaches its own payment method, and Meta bills the client per message (https://developers.facebook.com/docs/whatsapp/pricing).

4. **An admin System User.**
   - Assign it the app and the WABA.
   - Generate a token with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
   - Meta recommends System User tokens for direct developers (https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens.md).

5. **The app in Live mode.**
   - Meta: "some webhooks will not be sent if your app is in Dev mode" (https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks).
   - Needs a privacy policy URL (3.8), an icon and a category. The exact requirements for going Live are unverified.

6. **A webhook per app.**
   - Callback URL `https://<host>/api/webhook/whatsapp/<tenant key>` and the app's own verify token.
   - Subscribed fields: `messages`, `message_template_status_update`, `message_template_quality_update`, `template_category_update` and `account_update`. Add `user_id_update` once Meta offers it; whether it is available now is unverified (memory note of 2026-08-21).
   - Subscribe the app to the WABA with `POST /{waba_id}/subscribed_apps`.
   - Meta signs every payload with that app's App Secret (https://developers.facebook.com/docs/graph-api/webhooks/getting-started).

7. **Templates and Flows created and approved in the tenant's own WABA.** They cannot be copied from Sailendra's business: template migration only works between WABAs of the same business (https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-migration.md).

8. **Graph API version.**
   - The code puts v25.0 in every request URL. v21.0 stops working on 2027-01-21; v25.0 is supported until 2028-07-29; v26.0 is the newest (https://developers.facebook.com/docs/graph-api/changelog/versions).
   - Set each app's default version in its dashboard to match. Whether webhook payloads follow that setting is unverified.
   - Management API rate limits apply per app per WABA (https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform.md).

9. **People.**
   - Named Sarathi team members are added to each client portfolio with least privilege and removed at offboarding.
   - The client gives written authorization.

**Not required under C:** Tech Provider registration (2.8), App Review / Advanced access, and Embedded Signup.

**Required later for 5.4** (self-serve and coexistence):
- Embedded Signup must use v4 (https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions.md).
- WABAs created through developer apps cannot be selected in Embedded Signup (https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview.md). C tenants would therefore move to a platform app by partner sharing instead.

**Legal.** Clause 4.7 of Meta's WhatsApp Business terms covers AI providers. Counsel should confirm that a business's customer-service assistant run by Sarathi is allowed (https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform).

## Cost and operations

**Money**

- **Meta fees** are billed to each client's own WABA payment method.
  - Pricing has been per message since 2025-07-01.
  - Free: service replies inside the 24 h window, and utility templates sent inside it.
  - Charged: marketing and authentication templates.
  - An IDR rate card exists (https://developers.facebook.com/docs/whatsapp/pricing).
  - Sarathi pays Meta nothing and needs no credit line. Reselling messaging would require a Solution Partner, which is out of scope.
- **Supabase:**
  - Vault comes with the project at no extra cost, and the new tables are tiny.
  - Supabase Pro plus a restore drill (0.15) is still recommended, because Vault secrets depend on the project root key.
- **Hosting:** unchanged; the same Next.js service and cron container.

**Build effort**

- The tasks add up to 4 L, 6 M and 5 S.
- All four L tasks and most of the M work are independent of D6, so they can start now.
- The tracker budgets Fase 2 at about 2–3 weeks (docs/SAAS_PROGRESS.md:91). That only works if the D6-independent tasks run in parallel worktrees. This is an estimate, unverified. (Re-estimated on 2026-10-17 to about 2–3 months; the tracker now says so.)

**Per-tenant operations** (estimates, unverified)

- **Onboarding:** about 2–4 hours of team work, plus Meta's waiting times for business verification, display-name review and template review (likely days). The first tenant also needs a full rehearsal with a test portfolio.
- **Automated:** a daily health check makes 1 Graph call per number per day. That is far below Meta's management limits, which apply per app per WABA (https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform.md).
- **Weekly:** a review of unrouted ids, signature failures and template status. Minutes.
- **Quarterly, or when staff change:** token and app-secret rotation, about 15 minutes each with the staged-secret flow.
- **Before each Graph version expires:** an upgrade per app (bump `graph_api_version` and the dashboard setting), about 30 minutes per app roughly every 2 years.
- **Offboarding:**
  1. Run `wa_offboard_org`.
  2. Unsubscribe the webhook.
  3. Remove team members from the client's portfolio.
  4. Export the client's data (5.3).

  The client keeps its number, WABA, templates and quality rating, because it owns them.

**Scaling limit**

- Operations cost grows linearly with tenants: N apps, N tokens, N dashboards.
- That is fine for the 1–5 tenant pilot.
- Above roughly 10 tenants, or for self-serve, move to a platform app with Embedded Signup (5.4). The webhook pipeline already routes per entry, so the code change is mostly the app-to-org binding.
