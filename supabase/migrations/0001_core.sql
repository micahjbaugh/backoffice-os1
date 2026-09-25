-- Back Office OS — Core schema
-- Foundational only. M1 should extend/adjust through new migrations, not edit deployed migrations.

create extension if not exists pgcrypto;

create type public.membership_role as enum (
  'owner',
  'office_admin',
  'manager',
  'field_employee',
  'accountant_readonly'
);

create type public.approval_status as enum (
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled'
);

create type public.actor_type as enum (
  'user',
  'agent',
  'internal_operator',
  'integration',
  'system'
);

create type public.ops_case_status as enum (
  'new',
  'assigned',
  'waiting_external',
  'resolved',
  'closed'
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  timezone text not null default 'America/Chicago',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  phone text,
  email text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  phone text,
  email text,
  approved boolean not null default true,
  preferred boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  name text not null,
  status text not null default 'draft',
  address jsonb,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'open',
  priority text not null default 'normal',
  due_at timestamptz,
  entity_type text,
  entity_id uuid,
  assigned_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null,
  title text not null,
  description text,
  status public.approval_status not null default 'pending',
  amount_cents bigint,
  currency text default 'USD',
  entity_type text,
  entity_id uuid,
  requested_by_actor_type public.actor_type not null,
  requested_by_actor_id uuid,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  idempotency_key text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create table public.business_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action text not null,
  version integer not null default 1,
  enabled boolean not null default true,
  definition jsonb not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.business_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null,
  occurred_at timestamptz not null default now(),
  source text not null,
  source_ref text,
  actor_type public.actor_type not null,
  actor_id uuid,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid,
  causation_id uuid,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create unique index business_events_idempotency_unique
  on public.business_events(organization_id, idempotency_key)
  where idempotency_key is not null;

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  actor_type public.actor_type not null,
  actor_id uuid,
  action text not null,
  entity_type text,
  entity_id uuid,
  approval_id uuid references public.approvals(id) on delete set null,
  source_event_id uuid references public.business_events(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.internal_operator_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  operator_user_id uuid not null references auth.users(id) on delete cascade,
  granted_by_user_id uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  unique (organization_id, operator_user_id)
);

create table public.ops_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  reason_code text not null,
  status public.ops_case_status not null default 'new',
  priority text not null default 'normal',
  entity_type text,
  entity_id uuid,
  evidence jsonb not null default '{}'::jsonb,
  assigned_operator_user_id uuid references auth.users(id) on delete set null,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  classification text not null default 'confidential',
  entity_type text,
  entity_id uuid,
  sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  organization_id uuid references public.organizations(id) on delete set null,
  payload_hash text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',
  unique(provider, provider_event_id)
);

-- Helper: user membership
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(org_id uuid, allowed public.membership_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role = any(allowed)
  );
$$;

-- RLS
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.customers enable row level security;
alter table public.employees enable row level security;
alter table public.vendors enable row level security;
alter table public.jobs enable row level security;
alter table public.tasks enable row level security;
alter table public.approvals enable row level security;
alter table public.business_rules enable row level security;
alter table public.business_events enable row level security;
alter table public.audit_log enable row level security;
alter table public.internal_operator_grants enable row level security;
alter table public.ops_cases enable row level security;
alter table public.documents enable row level security;

create policy org_select on public.organizations
for select to authenticated
using (public.is_org_member(id));

create policy membership_select on public.memberships
for select to authenticated
using (organization_id in (
  select m.organization_id from public.memberships m where m.user_id = auth.uid()
));

-- Generic member-read policies
create policy customers_member_select on public.customers
for select to authenticated using (public.is_org_member(organization_id));
create policy employees_member_select on public.employees
for select to authenticated using (public.is_org_member(organization_id));
create policy vendors_member_select on public.vendors
for select to authenticated using (public.is_org_member(organization_id));
create policy jobs_member_select on public.jobs
for select to authenticated using (public.is_org_member(organization_id));
create policy tasks_member_select on public.tasks
for select to authenticated using (public.is_org_member(organization_id));
create policy approvals_member_select on public.approvals
for select to authenticated using (public.is_org_member(organization_id));
create policy documents_member_select on public.documents
for select to authenticated using (public.is_org_member(organization_id));

-- Mutation examples: owners/admins/managers.
create policy customers_staff_all on public.customers
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy vendors_staff_all on public.vendors
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy jobs_staff_all on public.jobs
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

-- Owner/admin approval mutation. Application server must add finer-grained checks.
create policy approvals_admin_update on public.approvals
for update to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin']::public.membership_role[]));

-- No direct client insert policies for audit/events/rules/ops/grants in initial schema.
-- These should be written through trusted server pathways.
