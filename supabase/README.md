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
`authenticated`, an app function has no pinned `search_path`, or anon holds
any privilege on a table, view or sequence in `public` (guard 11), so a
forgotten test is often caught anyway.

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
  tracker 1.11 (chat-media bucket is public) and 1.12 (documents policy
  falls back to the seed org). Remove the `todo` when fixing them.

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

## Schema fingerprint (production vs replay)

`fingerprint/schema_fingerprint.sql` prints one sorted line per app-owned
schema object (tables, columns, constraints, indexes, RLS flags, policies,
grants, functions with a hash of the body, triggers, buckets, realtime
publication). It contains catalog SELECTs only.

- `production.txt`: output of the query on production (committed snapshot).
- `local.txt`: output on a fresh local replay, kept for review.
- `expected-diff.txt`: differences that are known and explained, one per line
  (`<` only in production, `>` only in the replay), each with a reason:
  permanent ones, or *pending* lines of a migration not yet applied to
  production (see above). Entries that no longer differ fail as stale. Apart
  from the pending block `0063_revoke_anon_table_privileges` (the 20 anon
  `relpriv` pairs) it is empty: the replay up to 0062 matches production
  exactly (re-checked 2026-10-16 after applying 0062, against a fresh
  read-only production query: 563 lines, md5
  `bf9733425504e2bcbdc1a93ae91a413f`).
- Not fingerprinted: sequence privileges and default privileges
  (`pg_default_acl`). Whenever `production.txt` is refreshed (from 0063 on),
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
