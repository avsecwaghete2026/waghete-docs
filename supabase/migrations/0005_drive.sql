-- Swap Supabase Storage for Google Drive.
-- - Drop storage_path (no longer used).
-- - Add drive_file_id (the Google Drive file ID, returned by Drive API).
-- - Existing rows will have NULL drive_file_id and will fail to preview;
--   that's acceptable because this is a fresh deployment. If you have
--   existing data, re-upload through the app.

alter table public.documents
  drop column if exists storage_path;

alter table public.documents
  add column if not exists drive_file_id text not null default '';