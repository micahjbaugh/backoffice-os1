-- Back Office OS — M3 time entries
-- Extends 0001-0006 (treated as deployed; never edited). See docs/MILESTONES.md M3-T03.
--
-- Time entries are drafted by the Field Capture Agent from crew SMS/voice reports (MASTER_SPEC §8:
-- "create draft time entry" is a GREEN autonomous action) and then reviewed by staff, who move
-- status draft -> approved/rejected. Like leads (0004), this is a client-writable record table
-- restricted to staff (owner/office_admin/manager): field employees do not get direct table
-- access, so approval always happens through an authorized path, never an AI prompt (CLAUDE.md
-- rule 4). Mutations are audited by trigger (CLAUDE.md rule 8).

create type public.time_entry_status as enum ('draft', 'approved', 'rejected');

alter table public.jobs add constraint jobs_id_org_unique unique (id, organization_id);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null,
  job_id uuid not null,
  work_date date not null,
  start_at timestamptz,
  end_at timestamptz,
  hours numeric(6,2),
  status public.time_entry_status not null default 'draft',
  source_communication_id uuid,
  confidence jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_entries_employee_same_org_fkey foreign key (employee_id, organization_id)
    references public.employees(id, organization_id),
  constraint time_entries_job_same_org_fkey foreign key (job_id, organization_id)
    references public.jobs(id, organization_id),
  constraint time_entries_communication_same_org_fkey foreign key (source_communication_id, organization_id)
    references public.communications(id, organization_id) on delete set null (source_communication_id),
  constraint time_entries_end_after_start check (
    end_at is null or start_at is null or end_at >= start_at
  ),
  constraint time_entries_hours_nonnegative check (hours is null or hours >= 0)
);
alter table public.time_entries add constraint time_entries_id_org_unique unique (id, organization_id);

create index time_entries_org_work_date_idx on public.time_entries(organization_id, work_date);
create index time_entries_org_status_idx on public.time_entries(organization_id, status);
create index time_entries_employee_idx on public.time_entries(employee_id);
create index time_entries_job_idx on public.time_entries(job_id);
create index time_entries_communication_idx
  on public.time_entries(source_communication_id) where source_communication_id is not null;

create trigger time_entries_updated_at before update on public.time_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.time_entries enable row level security;

create policy time_entries_staff_all on public.time_entries
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create trigger time_entries_audit after insert or update or delete on public.time_entries
  for each row execute function public.audit_row_mutation('time_entry');
