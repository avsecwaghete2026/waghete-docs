-- Add soft-delete column to documents.
-- - deleted_at IS NULL  → active document (shown in search/detail)
-- - deleted_at IS NOT NULL → soft-deleted (kept in Drive, hidden from UI)

alter table public.documents
  add column if not exists deleted_at timestamptz;

-- Backfill: no existing rows should be marked deleted.
-- (Existing rows already have no deleted_at so they're already "active".)

-- RLS: admins can still see deleted rows if needed via direct query.
-- For the app-facing queries, the frontend/API filters deleted_at IS NULL.
