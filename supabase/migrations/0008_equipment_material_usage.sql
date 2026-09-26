-- Back Office OS — M3 equipment and material usage
-- Extends 0001-0007 (treated as deployed; never edited). See docs/MILESTONES.md M3-T04.
--
-- equipment_usages and material_usages are drafted by the Field Capture Agent from crew SMS/voice
-- reports, alongside time entries (0007_time_entries.sql: "equipment usage draft" / "material
-- usage" in MASTER_SPEC §C). Like time entries, they are staff-only client-writable record tables
-- (owner/office_admin/manager): field employees do not get direct table access, so approval always
-- happens through an authorized path, never an AI prompt (CLAUDE.md rule 4). Mutations are audited
-- by trigger (CLAUDE.md rule 8).

create type public.usage_status as enum ('draft', 'approved', 'rejected');

create table public.equipment_usages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  equipment_id uuid not null,
  job_id uuid not null,
  hours numeric(6,2),
  status public.usage_status not null default 'draft',
  source_communication_id uuid,
  confidence jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_usages_equipment_same_org_fkey foreign key (equipment_id, organization_id)
    references public.equipment(id, organization_id),
  constraint equipment_usages_job_same_org_fkey foreign key (job_id, organization_id)
    references public.jobs(id, organization_id),
  constraint equipment_usages_communication_same_org_fkey foreign key (source_communication_id, organization_id)
    references public.communications(id, organization_id),
  constraint equipment_usages_hours_nonnegative check (hours is null or hours >= 0)
);
alter table public.equipment_usages add constraint equipment_usages_id_org_unique unique (id, organization_id);

create index equipment_usages_org_status_idx on public.equipment_usages(organization_id, status);
create index equipment_usages_equipment_idx on public.equipment_usages(equipment_id);
create index equipment_usages_job_idx on public.equipment_usages(job_id);
create index equipment_usages_communication_idx
  on public.equipment_usages(source_communication_id) where source_communication_id is not null;

create trigger equipment_usages_updated_at before update on public.equipment_usages
  for each row execute function public.set_updated_at();

alter table public.equipment_usages enable row level security;

create policy equipment_usages_staff_all on public.equipment_usages
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create trigger equipment_usages_audit after insert or update or delete on public.equipment_usages
  for each row execute function public.audit_row_mutation('equipment_usage');

create table public.material_usages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  description text not null,
  quantity numeric(10,2),
  unit text,
  status public.usage_status not null default 'draft',
  source_communication_id uuid,
  confidence jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint material_usages_job_same_org_fkey foreign key (job_id, organization_id)
    references public.jobs(id, organization_id),
  constraint material_usages_communication_same_org_fkey foreign key (source_communication_id, organization_id)
    references public.communications(id, organization_id),
  constraint material_usages_quantity_nonnegative check (quantity is null or quantity >= 0)
);
alter table public.material_usages add constraint material_usages_id_org_unique unique (id, organization_id);

create index material_usages_org_status_idx on public.material_usages(organization_id, status);
create index material_usages_job_idx on public.material_usages(job_id);
create index material_usages_communication_idx
  on public.material_usages(source_communication_id) where source_communication_id is not null;

create trigger material_usages_updated_at before update on public.material_usages
  for each row execute function public.set_updated_at();

alter table public.material_usages enable row level security;

create policy material_usages_staff_all on public.material_usages
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create trigger material_usages_audit after insert or update or delete on public.material_usages
  for each row execute function public.audit_row_mutation('material_usage');
