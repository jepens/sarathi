#!/usr/bin/env bash
# Compare the schema of the LOCAL Supabase stack (after `supabase db reset`)
# with the committed production snapshot (audit KUA-1).
#
#   supabase/fingerprint/compare.sh            # diff local vs production.txt
#   supabase/fingerprint/compare.sh --write-local
#                                              # also keep local.txt for review
#
# Production is never contacted: production.txt is a snapshot taken with the
# same query (schema_fingerprint.sql) through the Supabase MCP execute_sql tool
# (read-only). See supabase/README.md to refresh it.
#
# Exit codes: 0 = exactly the differences listed in expected-diff.txt remain,
#             1 = unexpected differences, or entries in expected-diff.txt that
#                 no longer differ (stale; remove them), 2 = setup error.
#
# A migration PR is green BEFORE the migration reaches production: it lists
# the lines its migration adds/changes as "pending" entries in
# expected-diff.txt. Once the migration is applied to production and
# production.txt is refreshed, those entries become stale and must be removed
# in the same change (see supabase/README.md "How production migrations are
# applied").
#
# Connection: uses $LOCAL_DB_URL with psql when psql is installed, otherwise
# runs psql inside the local db container (supabase_db_<project_id>).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
supabase_dir="$(dirname "$here")"
query="$here/schema_fingerprint.sql"
snapshot="$here/production.txt"
expected="$here/expected-diff.txt"

project_id="$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$supabase_dir/config.toml")"
db_port="$(awk '/^\[db\]/{f=1;next} /^\[/{f=0} f && /^port = /{print $3; exit}' "$supabase_dir/config.toml")"
LOCAL_DB_URL="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:${db_port}/postgres}"

run_query() {
    if command -v psql >/dev/null 2>&1; then
        psql "$LOCAL_DB_URL" -X -q -A -t -v ON_ERROR_STOP=1 -f "$query"
    else
        local container="supabase_db_${project_id}"
        if ! docker inspect "$container" >/dev/null 2>&1; then
            echo "No psql and no running container $container - run 'npx supabase start' first." >&2
            exit 2
        fi
        docker exec -i "$container" psql -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1 <"$query"
    fi
}

local_out="$(mktemp)"
actual_diff="$(mktemp)"
trap 'rm -f "$local_out" "$actual_diff"' EXIT

run_query | tr -d '\r' | sed '/^$/d' >"$local_out"
if [[ "${1:-}" == "--write-local" ]]; then
    cp "$local_out" "$here/local.txt"
    echo "Wrote $here/local.txt"
fi

# "< line" = only in production, "> line" = only in the local replay.
diff <(tr -d '\r' <"$snapshot" | sed '/^$/d') "$local_out" | grep -E '^[<>] ' | LC_ALL=C sort >"$actual_diff" || true

unexpected="$(LC_ALL=C comm -23 "$actual_diff" <(grep -E '^[<>] ' "$expected" | tr -d '\r' | LC_ALL=C sort))"
stale="$(LC_ALL=C comm -13 "$actual_diff" <(grep -E '^[<>] ' "$expected" | tr -d '\r' | LC_ALL=C sort))"

echo "production: $(grep -c . "$snapshot") lines, local: $(grep -c . "$local_out") lines, differences: $(grep -c . "$actual_diff" || true) (expected: $(grep -cE '^[<>] ' "$expected" || true))"

status=0
if [[ -n "$stale" ]]; then
    echo
    echo "STALE entries in expected-diff.txt (no longer different; remove them):"
    echo "$stale"
    status=1
fi

if [[ -n "$unexpected" ]]; then
    echo
    echo "UNEXPECTED differences ('<' only in production, '>' only in the local replay):"
    echo "$unexpected"
    status=1
fi

if [[ $status -ne 0 ]]; then
    exit "$status"
fi

echo "OK: the local replay matches production except for the documented differences."
