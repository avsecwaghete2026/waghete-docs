-- Row Level Security — the real security boundary.
-- The frontend hides admin UI from viewers, but RLS is what actually
-- stops a viewer from POSTing to documents directly via the SDK.

alter table public.profiles   enable row level security;
alter table public.categories enable row level security;
alter table public.documents  enable row level security;

-- Helper: is the current requester an admin? Defined as a SECURITY
-- DEFINER function so it can read profiles without recursing into RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ============================================================
-- profiles policies
-- ============================================================
-- Any authenticated user can read their own profile (needed for the
-- role check that gates the admin UI).
create policy "profiles self read"
  on public.profiles for select
  using (auth.uid() = id);

-- Admins can read every profile (for the user-management UI).
create policy "profiles admin read"
  on public.profiles for select
  using (public.is_admin());

-- Only admins can write profiles. The trigger inserts via SECURITY
-- DEFINER so it bypasses RLS — no separate insert policy needed.
create policy "profiles admin write"
  on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- categories policies
-- ============================================================
-- Anyone authenticated can read categories (they appear in dropdowns).
create policy "categories read"
  on public.categories for select
  to authenticated
  using (true);

-- Only admins can mutate categories.
create policy "categories admin write"
  on public.categories for all
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- documents policies
-- ============================================================
-- Any authenticated user can SELECT.
create policy "documents read"
  on public.documents for select
  to authenticated
  using (true);

-- Only admins can INSERT.
create policy "documents admin insert"
  on public.documents for insert
  with check (public.is_admin());

-- Only admins can UPDATE.
create policy "documents admin update"
  on public.documents for update
  using (public.is_admin())
  with check (public.is_admin());

-- Only admins can DELETE.
create policy "documents admin delete"
  on public.documents for delete
  using (public.is_admin());