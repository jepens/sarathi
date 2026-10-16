-- Deterministic schema fingerprint (read-only).
--
-- One text line per schema object, sorted, so two databases can be compared
-- with a plain `diff`. Used to check that replaying supabase/migrations on a
-- fresh local stack reproduces the production schema (audit KUA-1).
--
-- Covers the app-owned surface:
--   * schemas public + private: tables (RLS flags, owner, effective table
--     privileges of anon/authenticated/service_role), columns (type,
--     nullability, default, identity/generated), constraints, indexes,
--     triggers, policies, enum types, sequences, views;
--   * functions in public + private: signature, return type, language,
--     volatility, SECURITY DEFINER, proconfig, owner, md5 of the body and the
--     EFFECTIVE EXECUTE privilege of anon / authenticated / service_role;
--   * triggers on auth.users that call app functions;
--   * schema USAGE for anon/authenticated/service_role on private/extensions;
--   * extensions (name + schema; versions are platform-managed, left out);
--   * supabase_realtime publication tables and realtime.messages policies
--     (who may join a private Broadcast topic);
--   * storage buckets and storage.objects policies.
--
-- Function bodies are hashed after removing `--` line comments and collapsing
-- whitespace, so CRLF vs LF checkouts (production functions were applied from
-- a Windows working copy), re-indentation and comment edits (several bodies
-- were applied to production with shortened comments) do not show up as
-- differences; any code token change does. (A `--` inside a string literal
-- would also be cut; no app function has one.)
--
-- The output depends on search_path (unqualified names in deparsed SQL), so
-- the file pins the Supabase default for the postgres role first.
--
-- Deliberately NOT covered: data, column order (attnum: production tables grew
-- column by column outside the repo), comments, statistics, platform-managed
-- schemas (auth/storage/realtime internals), extension versions.
--
-- Safe on production: catalog SELECTs only. Run it with
--   psql "$DB_URL" -X -A -t -f supabase/fingerprint/schema_fingerprint.sql
-- or paste it into the Supabase MCP execute_sql tool (it returns one row per
-- line in the `line` column).

set search_path to "$user", public, extensions;

with
app_ns as (
    select oid, nspname
    from pg_namespace
    where nspname in ('public', 'private')
),
ext_objs as (
    -- objects that belong to an extension (e.g. vector helper functions)
    select objid from pg_depend where deptype = 'e'
),
rels as (
    select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity,
           c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
    from pg_class c
    join app_ns n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and c.oid not in (select objid from ext_objs)
),
lines as (
    -- tables / views / sequences
    select format('rel %s.%s kind=%s owner=%s rls=%s force_rls=%s',
                  r.nspname, r.relname, r.relkind, r.owner,
                  r.relrowsecurity, r.relforcerowsecurity) as line
    from rels r

    union all
    -- effective table privileges of the API roles
    select format('relpriv %s.%s %s=%s', r.nspname, r.relname, ro.rolname,
                  concat_ws('',
                      case when has_table_privilege(ro.oid, r.oid, 'SELECT') then 'r' end,
                      case when has_table_privilege(ro.oid, r.oid, 'INSERT') then 'a' end,
                      case when has_table_privilege(ro.oid, r.oid, 'UPDATE') then 'w' end,
                      case when has_table_privilege(ro.oid, r.oid, 'DELETE') then 'd' end,
                      case when has_table_privilege(ro.oid, r.oid, 'TRUNCATE') then 'D' end,
                      case when has_table_privilege(ro.oid, r.oid, 'REFERENCES') then 'x' end,
                      case when has_table_privilege(ro.oid, r.oid, 'TRIGGER') then 't' end))
    from rels r
    cross join pg_roles ro
    where ro.rolname in ('anon', 'authenticated', 'service_role')
      and r.relkind in ('r', 'p', 'v', 'm')

    union all
    -- columns
    select format('col %s.%s.%s type=%s notnull=%s default=%s identity=%s generated=%s',
                  r.nspname, r.relname, a.attname,
                  format_type(a.atttypid, a.atttypmod),
                  a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
                  coalesce(nullif(a.attidentity, ''), '-'),
                  coalesce(nullif(a.attgenerated, ''), '-'))
    from rels r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where r.relkind in ('r', 'p', 'v', 'm', 'f')

    union all
    -- constraints (pk / fk / unique / check / exclusion; not-null is on col)
    select format('con %s.%s %s %s', r.nspname, r.relname, co.conname,
                  pg_get_constraintdef(co.oid))
    from rels r
    join pg_constraint co on co.conrelid = r.oid
    where co.contype in ('p', 'f', 'u', 'c', 'x')

    union all
    -- indexes
    select format('idx %s.%s %s', r.nspname, r.relname,
                  pg_get_indexdef(i.indexrelid))
    from rels r
    join pg_index i on i.indrelid = r.oid

    union all
    -- triggers on app tables, plus triggers anywhere that call app functions
    select format('trg %s.%s %s', tn.nspname, tc.relname, pg_get_triggerdef(t.oid))
    from pg_trigger t
    join pg_class tc on tc.oid = t.tgrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
    join pg_proc tp on tp.oid = t.tgfoid
    join pg_namespace fpn on fpn.oid = tp.pronamespace
    where not t.tgisinternal
      and (tn.nspname in ('public', 'private') or fpn.nspname in ('public', 'private'))

    union all
    -- RLS policies on app tables, storage.objects and realtime.messages
    -- (Realtime Authorization of the private org topics, 0064)
    select format('pol %s.%s "%s" %s cmd=%s roles=%s using=%s check=%s',
                  p.schemaname, p.tablename, p.policyname, p.permissive, p.cmd,
                  array_to_string(array(select unnest(p.roles) order by 1), ','),
                  coalesce(p.qual, '-'), coalesce(p.with_check, '-'))
    from pg_policies p
    where p.schemaname in ('public', 'private')
       or (p.schemaname = 'storage' and p.tablename = 'objects')
       or (p.schemaname = 'realtime' and p.tablename = 'messages')

    union all
    -- functions (body as md5 so the line stays short but any change shows)
    select format('fn %s.%s(%s) returns=%s lang=%s volatile=%s secdef=%s config=%s owner=%s body_md5=%s',
                  n.nspname, f.proname, pg_get_function_identity_arguments(f.oid),
                  pg_get_function_result(f.oid), l.lanname, f.provolatile,
                  f.prosecdef,
                  coalesce(array_to_string(f.proconfig, ';'), '-'),
                  pg_get_userbyid(f.proowner),
                  md5(btrim(regexp_replace(
                      regexp_replace(f.prosrc, '--[^\n]*', '', 'g'),
                      '\s+', ' ', 'g'))))
    from pg_proc f
    join app_ns n on n.oid = f.pronamespace
    join pg_language l on l.oid = f.prolang
    where f.oid not in (select objid from ext_objs)

    union all
    -- effective EXECUTE (includes grants to PUBLIC) per API role
    select format('fnexec %s.%s(%s) %s=%s', n.nspname, f.proname,
                  pg_get_function_identity_arguments(f.oid), ro.rolname,
                  has_function_privilege(ro.oid, f.oid, 'EXECUTE'))
    from pg_proc f
    join app_ns n on n.oid = f.pronamespace
    cross join pg_roles ro
    where ro.rolname in ('anon', 'authenticated', 'service_role')
      and f.oid not in (select objid from ext_objs)

    union all
    -- enum types
    select format('enum %s.%s [%s]', n.nspname, t.typname,
                  array_to_string(array(select e.enumlabel from pg_enum e
                                        where e.enumtypid = t.oid
                                        order by e.enumsortorder), ','))
    from pg_type t
    join app_ns n on n.oid = t.typnamespace
    where t.typtype = 'e'

    union all
    -- schema usage for the API roles
    select format('schema %s %s usage=%s create=%s', n.nspname, ro.rolname,
                  has_schema_privilege(ro.oid, n.oid, 'USAGE'),
                  has_schema_privilege(ro.oid, n.oid, 'CREATE'))
    from pg_namespace n
    cross join pg_roles ro
    where n.nspname in ('public', 'private', 'extensions')
      and ro.rolname in ('anon', 'authenticated', 'service_role')

    union all
    -- extensions (schema matters for search_path; version is platform-managed)
    select format('ext %s schema=%s', e.extname, en.nspname)
    from pg_extension e
    join pg_namespace en on en.oid = e.extnamespace

    union all
    -- realtime publication membership
    select format('pub %s %s.%s', pt.pubname, pt.schemaname, pt.tablename)
    from pg_publication_tables pt
    where pt.pubname = 'supabase_realtime'

    union all
    -- storage buckets
    select format('bucket %s public=%s size_limit=%s mime=%s',
                  b.id, b.public, coalesce(b.file_size_limit::text, '-'),
                  coalesce(array_to_string(b.allowed_mime_types, ','), '-'))
    from storage.buckets b
)
-- Collapse whitespace (multi-line policy expressions become one line) so the
-- output is strictly one object per line.
select line
from (select regexp_replace(line, '\s+', ' ', 'g') as line from lines) normalized
order by line collate "C";
