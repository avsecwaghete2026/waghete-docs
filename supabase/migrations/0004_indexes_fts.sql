-- Indexes for fast search + filters, plus a generated tsvector column
-- for Postgres full-text search on the title.

-- B-tree on the filter columns used in search WHERE clauses.
create index if not exists documents_category_idx     on public.documents (category_id);
create index if not exists documents_uploaded_by_idx  on public.documents (uploaded_by);
create index if not exists documents_upload_date_idx  on public.documents (upload_date desc);

-- GIN on tags supports overlap (&&) and contains (@>) operators.
create index if not exists documents_tags_gin_idx     on public.documents using gin (tags);

-- Generated tsvector column + GIN index for FTS on title.
alter table public.documents
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A')
  ) stored;

create index if not exists documents_search_vector_idx
  on public.documents using gin (search_vector);