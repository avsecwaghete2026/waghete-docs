-- Storage bucket: documents (PRIVATE).
-- Buckets are created via the dashboard or `supabase storage` CLI —
-- this file documents the RLS policies that must be applied to the
-- `storage.objects` table once the bucket exists.
--
-- Apply via Supabase Dashboard → Storage → documents → Policies,
-- or run the SQL below after creating the bucket:
--
--   insert into storage.buckets (id, name, public)
--   values ('documents', 'documents', false)
--   on conflict (id) do nothing;

-- Only authenticated users may request signed URLs (i.e. SELECT-equivalent
-- on the documents bucket). Anonymous access is denied.
create policy "documents bucket authenticated read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'documents');

-- Only admins may upload / replace / delete in the documents bucket.
create policy "documents bucket admin write"
  on storage.objects for all
  to authenticated
  using (
    bucket_id = 'documents'
    and public.is_admin()
  )
  with check (
    bucket_id = 'documents'
    and public.is_admin()
  );