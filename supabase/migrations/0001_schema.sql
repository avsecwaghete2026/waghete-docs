-- Schema: profiles, categories, documents, profile-creation trigger.
-- Run order: 0001_schema, 0002_trigger, 0003_rls, 0004_indexes_fts.

-- ============================================================
-- profiles: 1:1 with auth.users; role is the source of truth for
-- authorization. RLS reads role from this row.
-- ============================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  role        text not null check (role in ('admin', 'viewer')),
  created_at  timestamptz not null default now()
);

-- ============================================================
-- categories: admin-managed taxonomy. Documents FK to this so
-- renaming a category is a one-row update.
-- ============================================================
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- documents: metadata only — actual file bytes live in the
-- private "documents" Storage bucket, path stored here.
-- ============================================================
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  category_id   uuid references public.categories(id) on delete set null,
  tags          text[] not null default '{}',
  uploaded_by   uuid not null references public.profiles(id) on delete restrict,
  upload_date   timestamptz not null default now(),
  storage_path  text not null unique,
  file_type     text,
  file_size     bigint
);