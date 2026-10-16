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
`authenticated`, an app function has no pinned `search_path`, anon holds
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
  `170_documents_org_prefix.test.sql` pins the new policy and the 0066
  guard.)
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

## Realtime org bus (0064)

Live dashboard updates are moving from `postgres_changes` to ONE private
Broadcast topic per org, `org:<org uuid>` (lower-case uuid): 0064 is the
expand step; the client (one org channel per tab) and the contract 0068
(empty `supabase_realtime`) follow. Reason (KEA-15): `realtime.apply_rls`
sends the key columns of every DELETE to every subscriber of every org, and
filters chosen by the client do not isolate tenants.

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
  publication (the contract migration 0068, after the client deploy,
  empties it).
- **Verify after applying 0064** (read-only): 15 rows in `pg_trigger` with
  `tgname like 'trg_org_broadcast_%'`; exactly one policy on
  `realtime.messages`; `private.broadcast_org_changes` is SECURITY DEFINER
  and executable by no API role. After the next inbound WhatsApp message,
  `select count(*), count(distinct topic) from realtime.messages where topic
  like 'org:%' and inserted_at > now() - interval '15 minutes'` returns rows
  on one topic, and the queue jobs still complete (writes unaffected).

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
`supabase_realtime` publication (planned contract 0068: every signed-in user
of every org would receive the other orgs' DELETE keys again, KEA-15) and
never make the `chat-media` bucket public again (planned contract 0067,
KEA-4). Degrade instead: revert only the failing client build and accept
the reduced mode (ChatList and ChatWindow keep their polls; live updates
elsewhere pause), or first close the tenant-2 gate again (suspend the other
tenants' access). Expand migrations such as 0064 stay safe to roll back.

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
  production (see above). Entries that no longer differ fail as stale. Apart
  from the pending block `0066_documents_storage_org_prefix_only` (the old
  and the new `documents bucket org members` policy) it is empty: the replay
  up to 0065 matches production exactly (re-checked 2026-10-16 after applying
  0064 and 0065, against a fresh read-only production query: 591 lines, md5
  `d438f1ae53748103fde1baab4ab11ee3`).
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
