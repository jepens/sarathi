# supabase/

Database source of truth for Sarathi: migrations, the pgTAP tenant-isolation
suite and a schema fingerprint of production. Tracker 1.1 / 1.2 / 1.14,
audit KUA-1 / KUA-13.

```
config.toml              local stack (project_id "sarathi", ports 563xx)
migrations/              every schema change, replayable on an empty database
tests/database/          pgTAP suite run by `supabase test db`
fingerprint/             production schema snapshot + comparison script
```

## Rule: every new migration needs a test

A PR that adds a file to `migrations/` must also add or extend a test in
`tests/database/` that fails without the migration. For anything touching
tenant data that means at least:

- a new org-scoped table: add it to `010_tenant_tables_rls.test.sql`
  (`tests.check_tenant_table`, `tests.check_cross_org_blind`,
  `tests.check_anon_denied` for anon) and to the fixture list there;
- a new function: its EXECUTE grants in `050_rpc_grants.test.sql`
  (anon must not execute anything that reads or writes tenant data);
- a new storage bucket/policy: `040_storage.test.sql`.

**anon gets no table privileges (since 0063).** A table, view or sequence that
`postgres` creates in `public` (migrations run as `postgres`) gives `anon`
nothing: 0063 removed `anon` from the default privileges of `postgres` in
`public`, while `authenticated` and `service_role` keep their automatic
grants. Grant to `anon` only for a reviewed anonymous feature: explicitly in
the migration, with a test, and with guard 11 in `070` adjusted on purpose.
Caveat: the default privileges of `supabase_admin` in `public` still grant
`anon`, and `postgres` cannot change them, so never create objects or
extensions in `public` outside migrations. Functions are not covered: EXECUTE
still goes to `anon` by default (tracker 5.5), so keep revoking it for every
new function (`050`).

`070_catalog_guards.test.sql` fails automatically when a public table has RLS
off, a policy on an org_id table is not org-scoped (`is_org_member(...)`; a
policy scoped only to `user_id = auth.uid()` must be on the reviewed allowlist
in guard 4, so e.g. `auth.uid() IS NOT NULL` fails), a SECURITY DEFINER
function is executable by anon or is new to the reviewed list for
`authenticated`, an app function has no pinned `search_path`, the
`supabase_realtime` publication publishes any table, of any schema (guard 10,
since the contract 0068), anon holds
any privilege on a table, view or sequence in `public` (guard 11), a
`realtime.messages` policy is more than "members receive their joined org
topic" (guard 12, see "Realtime org bus" below) or a unique key on an org_id
table, primary keys included unless made only of surrogate columns, leaves
`org_id` out of its key columns (guard 13), so a forgotten test is often caught
anyway. Guard 13 has two reviewed global keys: `push_subscriptions_endpoint_key`
(one row per browser endpoint: the device follows whoever is signed in on it
now, owner decision D19; `register_push_subscription`, 0065, moves it) and
`whatsapp_integrations_phone_number_id_key` (a WhatsApp number belongs to one
org).

## Run the stack and the tests locally

Requires Docker. Use `npx supabase` (the CLI is not a project dependency); CI
pins **2.121.0**, use the same version locally when in doubt
(`npx supabase@2.121.0 ...`).

```bash
npx supabase db start          # Postgres only: enough for migrations + tests
# or: npx supabase start       # full stack (auth, storage API, studio, ...)

npx supabase db reset          # drop + replay every migration from scratch
npx supabase test db           # run tests/database/*.sql (pg_prove)
bash supabase/fingerprint/compare.sh   # local schema vs production snapshot

npx supabase stop --no-backup  # stop THIS project's stack only
```

`config.toml` uses `project_id = "sarathi"` and ports 56320-56329 so the stack
runs next to other local Supabase projects (which use the default 543xx ports
and their own project ids). `supabase stop` run from this repository only
stops the `supabase_*_sarathi` containers; never use `--all`.

### How the tests work

- `000-setup-tests-hooks.sql` runs first and (re)creates the `tests` schema
  with fixtures (two tenant orgs A/B, users a1/a2/b1, provisioned through the
  real `handle_new_user` path) and helpers. This schema exists only in the
  local database; it is not a migration.
- Every `*.test.sql` runs in `begin; ... rollback;`. The tests do not assume
  an empty database (counts are taken relative to a baseline), but
  `npx supabase db reset` first is the reference run, as in CI.
- `tests.authenticate_as(user)` / `authenticate_as_anon()` /
  `authenticate_as_service_role()` switch the transaction to the real API role
  and set the JWT claims `auth.uid()` reads. They raise an exception if the
  switch did not take effect, so an "is empty" assertion can never pass just
  because the test still runs as `postgres` (which bypasses RLS). 010 also
  asserts `current_user`/`auth.uid()` explicitly.
- Every assertion set in 010 (`check_tenant_table`, `check_cross_org_blind`,
  `check_no_access`, `check_anon_denied`) starts with a precondition counted
  through `tests.rows_ignoring_rls()` (SECURITY DEFINER, bypasses RLS): the
  rows the role must not read/update/delete really exist. A denial can
  therefore never pass on an empty table; a new table needs fixtures in 010 or
  it fails.
- anon's refusals are asserted with the exact message
  `permission denied for table <t>` (42501): it tells the missing table
  privilege (0063) apart from an RLS refusal, which has the same code.
- Known, not-yet-fixed gaps are `todo` tests (reported as
  `Failed (TODO)` without failing the run) and start passing once fixed:
  tracker 1.11 (chat-media bucket is public). Remove the `todo` when fixing
  it. (1.12, the documents seed-org fallback, is fixed by 0066; its
  production data move follows `docs/RUNBOOK_LEGACY_KB_OBJECTS.md`, and
  `170_documents_org_prefix.test.sql` pins the new policy and runs copies of
  the 0066 relink and guard predicates, which
  `scripts/lib/__tests__/migration-0066-parity.test.ts` keeps identical to the
  migration, refusal condition included.)
- `150_realtime_org_broadcast.test.sql` needs the `realtime.messages`
  partition of today (UTC). `db start` / `db reset` create the partitions
  from yesterday to +3 days, and no Realtime server runs afterwards to add
  more, so on a local stack started more than 3 days ago its precondition
  fails (it never skips): run `npx supabase db reset`.
  `tests.realtime_join_as(user, topic)` simulates Realtime's join check
  (the user's role and claims plus `realtime.topic`; a null user = anon key).
  Its behaviour block tells messages apart by id, not by `inserted_at`
  (production's default is `now()`, newer Realtime images use
  `clock_timestamp()`).

## Realtime org bus (0064 expand, client, 0068 contract)

Live dashboard updates use ONE private Broadcast topic per org,
`org:<org uuid>` (lower-case uuid), instead of Postgres Changes
(`postgres_changes` on the `supabase_realtime` publication). 0064 is the
expand step (applied 2026-10-16); the client (one org channel per tab, below)
and the contract 0068 (empty `supabase_realtime`) ship in one PR, and 0068 is
applied only after that build is live (runbook below). Reason (KEA-15):
`realtime.apply_rls` sends the key columns of every DELETE to every
subscriber of every org, and filters chosen by the client do not isolate
tenants; only an empty publication closes it.

- **Who receives.** The only policy on `realtime.messages`, "org members
  receive org broadcasts", is SELECT for `authenticated` on broadcast rows
  with `topic = realtime.topic()` (the topic being joined) when
  `private.is_org_member(private.realtime_topic_org_id(realtime.topic()))`.
  Realtime authorizes a private join by reading back its probe row for that
  topic under this policy. The topic equality is required: `realtime.send`
  runs `SET LOCAL realtime.topic`, so the setting stays for the rest of a
  writer's transaction. No INSERT/UPDATE/DELETE policy exists, so clients
  cannot send. Realtime caches this check per channel until the client sends
  a new JWT (at most `jwt_expiry`, 3600 s): a member removed from the org
  keeps receiving id/count signals until then; row data still flows only
  through PostgREST under RLS.
- **Who sends.** `private.broadcast_org_changes()`, from 15 statement-level
  triggers (`trg_org_broadcast_ins` / `_upd` / `_del`) on `whatsapp_chats`,
  `whatsapp_messages`, `labels`, `chat_labels` and `orders`: one
  `realtime.send` per org and statement, each in its own exception block, so
  a failed broadcast is a WARNING, never a failed write.
  - SECURITY DEFINER (owner `postgres`, `search_path ''`, EXECUTE revoked
    from every API role): `realtime.send` is SECURITY INVOKER and turns
    errors into WARNINGs, so an invoker trigger would silently drop the
    broadcast of every authenticated write.
  - Statement level with transition tables: `delete_contact_cascade`, a
    label delete (cascades to `chat_labels`) and `markChatRead` change many
    rows in one statement and would otherwise send one message per row.
    PostgreSQL refuses transition tables on multi-event triggers, hence one
    trigger per event.
- **Payload contract v1** (event = table name):
  `{"v": 1, "table": <table>, "op": "INSERT" | "UPDATE" | "DELETE", "n": <rows>, "ids": [<at most 50 ids>]}`
  plus the `id` that `realtime.send` adds. No phone numbers and no message
  text (`realtime.messages` keeps rows for about 3 days): clients refetch
  through PostgREST under RLS. `whatsapp_chats` and `chat_labels` have
  composite keys holding the phone number, so their `ids` are always `[]`;
  `n` larger than the number of ids means "refetch". A breaking change
  needs `"v": 2`.
- A new table the dashboard shows live gets the same three triggers and a
  row in the trigger check of `150`; never add it to the `supabase_realtime`
  publication (guard 10 of `070` fails: 0068 emptied it).
- **Verify after applying 0064** (read-only): 15 rows in `pg_trigger` with
  `tgname like 'trg_org_broadcast_%'`; exactly one policy on
  `realtime.messages`; `private.broadcast_org_changes` is SECURITY DEFINER
  and executable by no API role. After the next inbound WhatsApp message,
  `select count(*), count(distinct topic) from realtime.messages where topic
  like 'org:%' and inserted_at > now() - interval '15 minutes'` returns rows
  on one topic, and the queue jobs still complete (writes unaffected).
- **Client: one channel per tab.** `components/realtime/org-realtime-provider.tsx`
  (`OrgRealtimeProvider`, mounted in `app/dashboard/layout.tsx` inside
  `CurrentOrgProvider`) is the only code that opens a Realtime channel
  (`lib/realtime/__tests__/realtime-usage.test.ts` also fails on any
  `postgres_changes`): after `realtime.setAuth()` it joins
  `org:<orgId>` with `{ config: { private: true } }`, no channel without an
  org. Views subscribe with `useOrgRealtime(tables, handler)` or
  `useOrgRefetch(tables, refetch)` (coalesced: 400 ms quiet, at most every
  2 s) and refetch through PostgREST with `.eq('org_id', orgId)`, under
  RLS; a DELETE that names its ids drops those rows (the open chat,
  Bookings), a truncated event refetches. The ChatList (30 s) and ChatWindow
  (10 s) polls stay as a safety net. Every view gets a RESYNC on every
  SUBSCRIBED (the first one included), when the tab becomes visible and on
  `online`. The channel is re-created (removeChannel, setAuth, a new channel
  after 1 s, 2 s, 4 s ... 30 s) when the server closes it (CLOSED: an
  expired token, revoked access, a rate limit; realtime-js never rejoins a
  closed channel), after 3 failed joins in a row, or when no rejoin happened
  20 s after a failure; the CLOSED that its own removeChannel reports is
  ignored. `useOrgRealtimeStatus()` gives `live` / `paused`; the console logs
  status changes only (`[realtime] org:<uuid> live (SUBSCRIBED)`), never
  payloads. Local end-to-end check (Realtime v2.143.4, supabase-js 2.86):
  member join SUBSCRIBED, a label insert + delete as the member delivers
  exactly two v1 messages without any text, a whatsapp_chats write carries
  `ids: []` and no phone; another org's topic, anon and `org:not-a-uuid` are
  refused ("Unauthorized: You do not have permissions to read from this
  Channel topic"); a public channel with the same name receives nothing; at
  token expiry the server sends "Token has expired" and closes the channel,
  and the provider re-joins with a fresh token. The first join of an idle
  Realtime tenant starts its broadcast replication: writes in that first
  ~0.5 s were not delivered (the polls and the next RESYNC cover them).
- **Contract 0068 runbook** (details in the migration header):
  1. before the merge, as a team-controlled test-tenant account in
     production: join `org:<test org>` (private) and expect SUBSCRIBED,
     create + delete a label and expect two v1 broadcasts, join the seed
     org's topic and expect CHANNEL_ERROR (the first production check of
     private delivery);
  2. merge; deploy this PR in its own Easypanel build (not together with
     another contract such as the chat-media contract 0067), confirm the
     build id changed, smoke-test with two tabs (SUBSCRIBED in the console,
     inbox + open chat + alert on an inbound message, a label toggle across
     tabs, a contact rename, a booking in Bookings);
  3. reload every open dashboard tab; `select count(*) from
     realtime.subscription` must be 0 (no Postgres Changes subscriber left);
  4. apply 0068; `select count(*) from pg_publication_tables where pubname =
     'supabase_realtime'` must be 0; repeat the smoke test;
  5. the owner turns off "Allow public access" (Dashboard > Realtime >
     Settings), which disconnects every socket once: a tab that was NOT
     reloaded must recover by itself; check also that a non-private join
     with the anon key is now refused;
  6. follow-up PR: refresh `production.txt`, delete the 0068 block of
     `expected-diff.txt`, tracker 1.9 to done. Only then may a second tenant
     get real data.
- **Tenant-2 rule.** After a second tenant has real data, 0068 is never
  rolled back by re-adding tables to `supabase_realtime` (every signed-in
  user of every org would receive the other orgs' DELETE keys again): roll
  forward, or degrade to polling by reverting only the failing client build,
  or first close the tenant-2 gate again. See "Contract migrations".

## Migration naming and ordering

Files must match `^([0-9]+)_(.*)\.sql$` (the regex in the CLI binary); the
digits before the first `_` are the **version**, stored as text in
`supabase_migrations.schema_migrations`. The CLI applies migrations in order of
that version compared **as text**, so a shorter version that is a prefix of a
longer one comes first. Verified with CLI 2.121.0 (`db reset` log and the
recorded versions):

```
0000  0001  00010  00011  0002  0003  0004  00041  0005  ...  0060
```

- `00010_baseline_pre_repo_schema.sql`: tables/functions production got by
  hand (SQL editor, `database/*.sql`) before the repo kept migrations.
- `00011_enable_rls_and_policies.sql`: replay of production migration
  `20260526101729 enable_rls_and_policies`, which was never committed.
- `00041_vendors_table.sql` (was `0004_vendors_table.sql`): renamed because
  two files sharing version `0004` collide on the `schema_migrations` primary
  key.

Both orders the CLI has used for these files (by version string, or by file
name where `00010_` < `0001_`) produce the same schema: `0001` only adds
storage policies, `0004` only the proposals bucket. Do not insert new files
between existing ones; new migrations continue the sequence
(`0061_<name>.sql`, `0062_...`). Keep the 4-digit prefix so ordering stays
obvious.

Note on production history: local versions (`0058`) and production versions
(timestamps such as `20261015165907`, name `0058_fase0_tenant_isolation`)
differ, and production has no entry for 0000/0001/00010. Never run
`supabase db push` or `supabase migration repair` against production; the
histories are not meant to line up.

## How production migrations are applied

Production is changed only through the Supabase MCP `apply_migration` tool,
one migration per call, using the file's content and its name without the
`.sql` extension (e.g. `0061_add_x`). The platform records it under a
timestamp version (see `list_migrations`).

The `db-tests` CI job (`.github/workflows/ci.yml`) runs `supabase db start`,
`supabase test db` and `compare.sh` on every push and pull request; all three
steps are blocking. Because `production.txt` describes production, a new
migration is first an *expected, pending* difference. Order of work, all in
one PR:

1. **PR, before production.** Write `migrations/00NN_name.sql` + its test.
   Run `npx supabase db reset`, `npx supabase test db` and
   `bash supabase/fingerprint/compare.sh`. compare.sh lists the lines the
   migration adds (`>`) or changes (`<` old / `>` new) as unexpected; copy
   them verbatim into `fingerprint/expected-diff.txt` under a comment
   `# pending production apply: 00NN_name`. Now everything is green locally
   and in CI, and the PR is reviewed with production untouched.
2. **After approval, apply.** Apply the same file to production with
   `apply_migration`.
3. **Close the loop in the same PR.** Refresh `fingerprint/production.txt`
   (below) and delete the pending lines from `expected-diff.txt`. compare.sh
   must report 0 differences; leftover pending lines now fail as *stale*, so
   they cannot be forgotten. Merge.

If the PR is merged before step 2 (not recommended), main stays green with
the pending lines; steps 2-3 then happen in a follow-up PR. Never apply a
migration to production that has not passed step 1 and review.

**Contract migrations (applied after the code deploy).** A merge to `main`
does not deploy anything by itself: the app service is redeployed manually in
Easypanel (the old docs, e.g. `docs/VPS_DEPLOYMENT.md`, still describe an
auto-deploy). A migration that the live code is not compatible with (e.g.
`0062_tenant_schema_contract`: drops column defaults and global unique keys
the old code relies on) therefore cannot close its loop in the same PR. Its
pending block stays in `expected-diff.txt` through the merge:

1. Apply the expand migration (`0061`), refresh `production.txt` and delete
   its pending block, in the PR. If the contract migration redefines a
   function the expand one created, its block carries prepared, commented
   `<` lines for the expand bodies: un-comment them in the same commit.
2. Merge, then redeploy the app service in Easypanel and confirm the new build
   is live (the Next.js build id in the page payload changes). The cron
   service (`deploy/cron`) only curls `/api/queue/process` and runs no app
   code, so it needs no redeploy.
3. Only then apply the contract migration; never while the live build lacks
   the code it depends on (the migration header names the PR).
4. Follow-up PR: refresh `production.txt` and delete the contract block.

**Rolling back a contract once a second tenant has real data.** While
Sailendra is the only tenant with real data, a contract can be rolled back
by restoring what it removed. After a second tenant is onboarded, a rollback
must never reopen a cross-tenant leak: never re-add tables to the
`supabase_realtime` publication (contract 0068: every signed-in user of
every org would receive the other orgs' DELETE keys again, KEA-15) and
never make the `chat-media` bucket public again (planned contract 0067,
KEA-4). Degrade instead: revert only the failing client build and accept
the reduced mode (ChatList and ChatWindow keep their polls; live updates
elsewhere pause), or first close the tenant-2 gate again (suspend the other
tenants' access). Expand migrations such as 0064 stay safe to roll back.

**One contract per build.** Ship each contract's client PR in its own
Easypanel build (e.g. the Realtime client + 0068 apart from the chat-media
client + 0067): a build that carries several contracts can only be rolled
back by undoing all of them, in reverse order, against a database that is
already contracted. After a contract is applied, the default is to roll
forward with a patch build; the rollback in the migration header is the
exception (and only while Sailendra is the only tenant with real data).
Deploying an older build is not documented for Easypanel: roll back by
deploying a revert commit of `main`.

## Schema fingerprint (production vs replay)

`fingerprint/schema_fingerprint.sql` prints one sorted line per app-owned
schema object (tables, columns, constraints, indexes, RLS flags, policies,
grants, functions with a hash of the body, triggers, buckets, realtime
publication, and the policies on `realtime.messages`, which decide who may
join a private Broadcast topic). It contains catalog SELECTs only. The
`realtime.messages` policies were added to the query with 0064; production
had none (read-only check 2026-10-16), so this query change alone adds no
line to `production.txt`.

- `production.txt`: output of the query on production (committed snapshot).
- `local.txt`: output on a fresh local replay, kept for review.
- `expected-diff.txt`: differences that are known and explained, one per line
  (`<` only in production, `>` only in the replay), each with a reason:
  permanent ones, or *pending* lines of a migration not yet applied to
  production (see above). Entries that no longer differ fail as stale. It
  currently holds one pending block, the contract 0068 (the 4 `< pub
  supabase_realtime ...` lines; applied after the client deploy). Apart from
  that the replay matches production exactly (re-checked 2026-10-16 after
  applying 0066, against a fresh read-only production query: 591 lines, md5
  `21e9979435c772701da8c85417fba71f`).
- Not fingerprinted: sequence privileges, column-level privileges, MAINTAIN,
  foreign-table privileges and default privileges (`pg_default_acl`); the
  `relpriv` lines cover only `arwdDxt` on tables and views. Whenever
  `production.txt` is refreshed (once 0063 is applied to production),
  also run read-only on production the query of guard 11 in
  `070_catalog_guards.test.sql` (tables, views, sequences) and the one of the
  first assertion in `140_anon_no_table_access.test.sql` (default
  privileges): both must return no row.

Compare a fresh replay with the snapshot:

```bash
npx supabase db reset
bash supabase/fingerprint/compare.sh             # exit 0 = OK
bash supabase/fingerprint/compare.sh --write-local   # also rewrite local.txt
```

Refresh the production snapshot (read-only):

1. Run the content of `schema_fingerprint.sql` with the Supabase MCP
   `execute_sql` tool against production.
2. Write the `line` values, one per line, in the returned order, to
   `production.txt` (LF line endings, trailing newline).
3. Run `compare.sh`; explain or fix every difference and remove pending
   entries that are now applied.

Quick drift check without copying 500+ lines: replace the final
`select line ... order by line collate "C";` of the query with

```sql
select count(*) as n, md5(string_agg(line, E'\n' order by line collate "C")) as h
from (select regexp_replace(line, '\s+', ' ', 'g') as line from lines) normalized;
```

and run it on production; compare with
`printf '%s' "$(grep -v '^$' supabase/fingerprint/production.txt | tr -d '\r')" | md5sum`
(portable: works with GNU and BSD/macOS tools)
(or run the same modified query on the local stack). Equal hashes mean the
snapshot is current.
