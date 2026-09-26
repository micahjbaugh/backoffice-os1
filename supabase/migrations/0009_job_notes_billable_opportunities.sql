-- Back Office OS — M3 job notes and billable opportunities
-- Extends 0001-0008 (treated as deployed; never edited). See docs/MILESTONES.md M3-T05.
--
-- job_notes captures daily field notes drafted by the Field Capture Agent (MASTER_SPEC §C "daily
-- job notes"); it is informational and has no approval workflow. billable_opportunities captures
-- possible customer-requested scope changes (MASTER_SPEC §D "detect customer-requested additions" /
-- "create billable opportunity", ARCHITECTURE.md step 7) that the owner must review before any
-- invoicing work (M4) can use them: open -> approved (billable) or dismissed. Both are staff-only
-- client-writable tables like the other M3 draft tables (0006-0008): field employees do not get
-- direct table access, so review always happens through an authorized path, never an AI prompt
-- (CLAUDE.md rule 4). Mutations are audited by trigger (CLAUDE.md rule 8).

create table public.job_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  body text not null check (char_length(body) between 1 and 4000),
  source_communication_id uuid,
  confidence jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_notes_job_same_org_fkey foreign key (job_id, organization_id)
    references public.jobs(id, organization_id),
  constraint job_notes_communication_same_org_fkey foreign key (source_communication_id, organization_id)
    references public.communications(id, organization_id)
);
alter table public.job_notes add constraint job_notes_id_org_unique unique (id, organization_id);

create index job_notes_org_idx on public.job_notes(organization_id);
create index job_notes_job_idx on public.job_notes(job_id);
create index job_notes_communication_idx
  on public.job_notes(source_communication_id) where source_communication_id is not null;

create trigger job_notes_updated_at before update on public.job_notes
  for each row execute function public.set_updated_at();

alter table public.job_notes enable row level security;

create policy job_notes_staff_all on public.job_notes
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create trigger job_notes_audit after insert or update or delete on public.job_notes
  for each row execute function public.audit_row_mutation('job_note');

create type public.billable_opportunity_status as enum ('open', 'approved', 'dismissed');

create table public.billable_opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  description text not null,
  quantity numeric(10,2),
  unit text,
  status public.billable_opportunity_status not null default 'open',
  source_communication_id uuid,
  confidence jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billable_opportunities_job_same_org_fkey foreign key (job_id, organization_id)
    references public.jobs(id, organization_id),
  constraint billable_opportunities_communication_same_org_fkey foreign key (source_communication_id, organization_id)
    references public.communications(id, organization_id),
  constraint billable_opportunities_quantity_nonnegative check (quantity is null or quantity >= 0)
);
alter table public.billable_opportunities add constraint billable_opportunities_id_org_unique unique (id, organization_id);

create index billable_opportunities_org_status_idx on public.billable_opportunities(organization_id, status);
create index billable_opportunities_job_idx on public.billable_opportunities(job_id);
create index billable_opportunities_communication_idx
  on public.billable_opportunities(source_communication_id) where source_communication_id is not null;

create trigger billable_opportunities_updated_at before update on public.billable_opportunities
  for each row execute function public.set_updated_at();

alter table public.billable_opportunities enable row level security;

create policy billable_opportunities_staff_all on public.billable_opportunities
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create trigger billable_opportunities_audit after insert or update or delete on public.billable_opportunities
  for each row execute function public.audit_row_mutation('billable_opportunity');
