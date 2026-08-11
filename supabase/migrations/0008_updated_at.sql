-- Track when each document was last modified. Distinct from upload_date
-- (which is set once at insert) so the UI can sort "recently edited" up
-- to the top.

alter table public.documents
  add column if not exists updated_at timestamptz not null default now();

-- Backfill: existing rows keep now() as their updated_at. New rows pick
-- it up from the column default; UPDATEs are handled by the trigger.

-- Generic updated_at trigger fn. Reused by other tables if needed later.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();
