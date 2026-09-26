-- Back Office OS — M3 equipment registry
-- Extends 0001-0005 (treated as deployed; never edited). See docs/MILESTONES.md M3-T02.
--
-- Equipment is a client-writable record table like customers/employees/vendors (0001/0002 §5-6):
-- any org member can read, owner/office_admin/manager can mutate, and mutations are audited by
-- trigger (CLAUDE.md rule 8). Field capture matching (M3-T12) will resolve free-text references
-- like "Hoe" or "D6" against name/aliases within one organization.

create table public.equipment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  type text not null,
  aliases text[] not null default '{}',
  internal_cost_rate_cents bigint,
  billable_rate_cents bigint,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.equipment add constraint equipment_id_org_unique unique (id, organization_id);

create index equipment_org_idx on public.equipment(organization_id, active);

create trigger equipment_updated_at before update on public.equipment
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.equipment enable row level security;

create policy equipment_member_select on public.equipment
for select to authenticated using (public.is_org_member(organization_id));

create policy equipment_staff_all on public.equipment
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create trigger equipment_audit after insert or update or delete on public.equipment
  for each row execute function public.audit_row_mutation('equipment');
