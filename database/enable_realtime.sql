-- OBSOLETE (tracker 1.9; migrations 0064 and 0068): do NOT add tables to
-- supabase_realtime. This script used to run
-- `ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_chats / whatsapp_messages`.
-- Live dashboard updates now use the private org broadcast (topic
-- 'org:<org uuid>', see supabase/README.md "Realtime org bus"), and the
-- publication must stay empty: Postgres Changes sends the key columns of
-- every DELETE (customer phone numbers included) to every subscriber, of any
-- org (audit KEA-15). Guard 10 of supabase/tests/database/070_catalog_guards
-- fails when a table is published.

-- Read-only check: must return no row.
SELECT
    schemaname,
    tablename,
    pubname
FROM
    pg_publication_tables
WHERE
    pubname = 'supabase_realtime';
