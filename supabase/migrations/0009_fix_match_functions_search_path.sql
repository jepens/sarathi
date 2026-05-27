-- Hotfix for 0008: the search_path was written as a single quoted string
-- 'public, extensions' which Postgres stored as ONE schema name containing
-- a comma+space — not as a list of two schemas. As a result match_documents
-- and match_products couldn't resolve `documents`/`products` tables and
-- crashed at runtime ("relation does not exist"). Use unquoted identifier
-- list (the correct syntax for multi-schema search_path).

alter function public.match_documents(extensions.vector, double precision, integer)
    reset search_path;
alter function public.match_documents(extensions.vector, double precision, integer)
    set search_path = public, extensions;

alter function public.match_products(extensions.vector, double precision, integer)
    reset search_path;
alter function public.match_products(extensions.vector, double precision, integer)
    set search_path = public, extensions;
