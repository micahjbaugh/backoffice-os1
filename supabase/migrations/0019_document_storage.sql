-- PH-T03: a private Supabase Storage bucket for documents, RLS-scoped by organization to match the
-- public.documents metadata table (migrations 0001/0002: member-read, owner/office_admin/manager
-- write). storage.buckets and storage.objects are Supabase-managed tables that already exist on a
-- hosted project; neither is created here (packages/core/test/helpers/supabase-shim.sql adds a
-- stand-in so the same SQL is exercised against the in-process test database).

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- A document's storage object must live under its own organization's folder ("<org id>/..."), so
-- ownership of the metadata row is the same thing as ownership of the underlying object. Without
-- this, a caller could register metadata claiming a storage_path under a *different* organization's
-- folder and read that organization's file through a signed URL minted for "their own" document.
alter table public.documents
  add constraint documents_storage_path_scoped check (
    split_part(storage_path, '/', 1) = organization_id::text
  );

-- The first path segment of a storage object name, as the organization id it must belong to, or
-- null when that segment is not a uuid at all. Returning null (rather than raising) means a
-- malformed object name makes every policy below simply deny access instead of erroring the query.
create or replace function public.storage_object_org_id(object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when (string_to_array(object_name, '/'))[1] ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then ((string_to_array(object_name, '/'))[1])::uuid
    else null
  end
$$;

-- Supabase ships storage.objects with row level security already enabled and owned by
-- supabase_storage_admin, so this migration cannot (and need not) enable it; doing so fails with
-- "must be owner of table objects" on a real stack. The test shim enables it on its stand-in.

create policy documents_bucket_member_select on storage.objects
for select to authenticated
using (
  bucket_id = 'documents'
  and public.is_org_member(public.storage_object_org_id(name))
);

create policy documents_bucket_staff_write on storage.objects
for insert to authenticated
with check (
  bucket_id = 'documents'
  and public.has_org_role(
    public.storage_object_org_id(name),
    array['owner', 'office_admin', 'manager']::public.membership_role[]
  )
);

create policy documents_bucket_staff_update on storage.objects
for update to authenticated
using (
  bucket_id = 'documents'
  and public.has_org_role(
    public.storage_object_org_id(name),
    array['owner', 'office_admin', 'manager']::public.membership_role[]
  )
)
with check (
  bucket_id = 'documents'
  and public.has_org_role(
    public.storage_object_org_id(name),
    array['owner', 'office_admin', 'manager']::public.membership_role[]
  )
);

create policy documents_bucket_staff_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'documents'
  and public.has_org_role(
    public.storage_object_org_id(name),
    array['owner', 'office_admin', 'manager']::public.membership_role[]
  )
);
