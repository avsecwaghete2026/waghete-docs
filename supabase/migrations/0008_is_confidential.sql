-- Adds is_confidential flag to documents.
-- Confidential documents are hidden from non-admin users via RLS.

alter table public.documents
  add column if not exists is_confidential boolean not null default false;
