-- Back Office OS — M2 leads
-- Extends 0001/0002/0003 (treated as deployed; never edited). See docs/MASTER_SPEC.md §11.
--
-- Access model: leads are a client-writable record table like employees/tasks (0002 §5), so staff
-- get a single "for all" policy and mutations are audited by trigger (CLAUDE.md rule 8).
-- lead_activities is a system-authored timeline (like notes/business_events, 0002 §5): trusted
-- server/agent code writes it after code-level authorization; members get read-only access.

create type public.lead_status as enum (
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'converted',
  'lost'
);

create type public.lead_source as enum (
  'voice',
  'sms',
  'email',
  'web_form',
  'referral',
  'manual',
  'other'
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status public.lead_status not null default 'new',
  source public.lead_source not null default 'other',
  first_name text,
  last_name text,
  company text,
  phone text,
  email text,
  customer_id uuid,
  assigned_to_employee_id uuid,
  originating_communication_id uuid,
  description text,
  lost_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_converted_requires_customer check (status <> 'converted' or customer_id is not null),
  constraint leads_customer_same_org_fkey foreign key (customer_id, organization_id)
    references public.customers(id, organization_id) on delete set null (customer_id),
  constraint leads_employee_same_org_fkey foreign key (assigned_to_employee_id, organization_id)
    references public.employees(id, organization_id) on delete set null (assigned_to_employee_id),
  constraint leads_communication_same_org_fkey foreign key (originating_communication_id, organization_id)
    references public.communications(id, organization_id) on delete set null (originating_communication_id)
);
alter table public.leads add constraint leads_id_org_unique unique (id, organization_id);

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null,
  activity_type text not null,
  actor_type public.actor_type not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  communication_id uuid,
  body text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint lead_activities_type_check check (
    activity_type in ('status_change', 'note', 'communication', 'assignment', 'follow_up', 'other')
  ),
  constraint lead_activities_lead_same_org_fkey foreign key (lead_id, organization_id)
    references public.leads(id, organization_id) on delete cascade,
  constraint lead_activities_communication_same_org_fkey foreign key (communication_id, organization_id)
    references public.communications(id, organization_id) on delete set null (communication_id)
);

create index leads_org_status_idx on public.leads(organization_id, status);
create index leads_customer_idx on public.leads(customer_id) where customer_id is not null;
create index leads_assigned_idx on public.leads(assigned_to_employee_id) where assigned_to_employee_id is not null;
create index lead_activities_org_lead_idx on public.lead_activities(organization_id, lead_id, occurred_at desc);

create trigger leads_updated_at before update on public.leads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;

create policy leads_staff_all on public.leads
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy lead_activities_select on public.lead_activities
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[])
);

revoke insert, update, delete on public.lead_activities from authenticated;

create trigger leads_audit after insert or update or delete on public.leads
  for each row execute function public.audit_row_mutation('lead');
