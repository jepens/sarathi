-- Fase 1c — scope RAG retrieval to an org. Add an optional `filter_org_id`
-- parameter to the vector-search functions (pattern: Supabase "Filtering vector
-- search by metadata"). Default null = no filter, so existing 3-arg callers keep
-- the current behaviour until rag.ts is updated to pass the org. This prevents a
-- tenant's AI from retrieving another tenant's Knowledge Base / products.

drop function if exists public.match_documents(vector, double precision, integer);
create or replace function public.match_documents(
    query_embedding vector,
    match_threshold double precision,
    match_count integer,
    filter_org_id uuid default null
)
returns table(id uuid, content text, metadata jsonb, similarity double precision)
language plpgsql
set search_path to 'public', 'extensions'
as $function$
begin
    return query
    select
        documents.id,
        documents.content,
        documents.metadata,
        1 - (documents.embedding <=> query_embedding) as similarity
    from documents
    where 1 - (documents.embedding <=> query_embedding) > match_threshold
      and (filter_org_id is null or documents.org_id = filter_org_id)
    order by documents.embedding <=> query_embedding
    limit match_count;
end;
$function$;

drop function if exists public.match_products(vector, double precision, integer);
create or replace function public.match_products(
    query_embedding vector,
    match_threshold double precision,
    match_count integer,
    filter_org_id uuid default null
)
returns table(id uuid, name text, description text, price numeric, stock integer, metadata jsonb, similarity double precision)
language plpgsql
set search_path to 'public', 'extensions'
as $function$
begin
    return query
    select
        products.id,
        products.name,
        products.description,
        products.price,
        products.stock,
        products.metadata,
        1 - (products.embedding <=> query_embedding) as similarity
    from products
    where 1 - (products.embedding <=> query_embedding) > match_threshold
      and (filter_org_id is null or products.org_id = filter_org_id)
    order by products.embedding <=> query_embedding
    limit match_count;
end;
$function$;
