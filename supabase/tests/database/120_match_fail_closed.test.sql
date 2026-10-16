-- match_documents / match_products fail closed per org (migration 0061;
-- tracker 1.13, audit KEA-25): a NULL filter_org_id returns no rows — also
-- for the service role, which bypasses RLS — and a given org only its rows.
begin;
select plan(10);

select tests.create_two_orgs();

insert into public.documents (org_id, content, embedding) values
    (tests.org_a(), 'dokumen A', array_fill(0.1::real, array[1536])::extensions.vector),
    (tests.org_b(), 'dokumen B', array_fill(0.1::real, array[1536])::extensions.vector);
insert into public.products (org_id, name, price, embedding) values
    (tests.org_a(), 'produk A', 1000, array_fill(0.1::real, array[1536])::extensions.vector),
    (tests.org_b(), 'produk B', 1000, array_fill(0.1::real, array[1536])::extensions.vector);

-- Service role (the RAG / webhook path): no RLS, so the filter is the boundary.
select tests.authenticate_as_service_role();
select is_empty(
    $$ select 1 from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100) $$,
    'service_role, match_documents without filter_org_id: no rows');
select is_empty(
    $$ select 1 from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100, null) $$,
    'service_role, match_documents with filter_org_id NULL: no rows');
select results_eq(
    $$ select content from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100, tests.org_b()) $$,
    array['dokumen B'],
    'service_role, match_documents for org B: only org B''s documents');
select is_empty(
    $$ select 1 from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100) $$,
    'service_role, match_products without filter_org_id: no rows');
select is_empty(
    $$ select 1 from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100, null) $$,
    'service_role, match_products with filter_org_id NULL: no rows');
select results_eq(
    $$ select name from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100, tests.org_b()) $$,
    array['produk B'],
    'service_role, match_products for org B: only org B''s products');

-- A member (RLS on top): no filter → nothing; own org → own rows.
select tests.authenticate_as(tests.user_a1());
select is_empty(
    $$ select 1 from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100) $$,
    'member, match_documents without filter_org_id: no rows');
select results_eq(
    $$ select content from public.match_documents(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100, tests.org_a()) $$,
    array['dokumen A'],
    'member, match_documents for their org: their documents');
select is_empty(
    $$ select 1 from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100) $$,
    'member, match_products without filter_org_id: no rows');
select results_eq(
    $$ select name from public.match_products(array_fill(0.1::real, array[1536])::extensions.vector, -1, 100, tests.org_a()) $$,
    array['produk A'],
    'member, match_products for their org: their products');

select * from finish();
rollback;
