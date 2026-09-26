-- Back Office OS — M1 foundation
-- Extends 0001_core.sql (treated as deployed; never edited). See docs/M1_IMPLEMENTATION_PLAN.md.
--
-- Access model:
--   * Browser/PostgREST and the app server's "user context" both run as role `authenticated`
--     with the user's JWT claims, so RLS below is the tenant-isolation boundary for both.
--   * Tables that record decisions, provenance or access (approvals, events, audit, ops cases,
--     grants, rules, notes, orgs, memberships) are written only by trusted server code running as
--     the table owner after code-level authorization. Clients get read-only (RLS-filtered) access.
--   * Client-writable record tables (customers, employees, vendors, jobs, tasks, documents) are
--     audited by trigger, so every mutation is audited no matter which path made it.

-- ---------------------------------------------------------------------------
-- 1. Internal staff (Back Office OS operators). Not a tenant role.
-- ---------------------------------------------------------------------------
create type public.internal_staff_role as enum ('ops_agent', 'ops_supervisor', 'platform_admin');

create table public.internal_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.internal_staff_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Operator grants: expiring, revocable, historical.
-- ---------------------------------------------------------------------------
alter table public.internal_operator_grants
  drop constraint internal_operator_grants_organization_id_operator_user_id_key;
alter table public.internal_operator_grants
  add column revoked_at timestamptz,
  add column revoked_by_user_id uuid references auth.users(id) on delete set null,
  alter column expires_at set not null,
  alter column reason set not null;
create unique index internal_operator_grants_one_active
  on public.internal_operator_grants(organization_id, operator_user_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 3. Schema extensions for M1 entities.
-- ---------------------------------------------------------------------------
create type public.risk_class as enum ('green', 'yellow', 'red');

alter table public.approvals
  add column risk_class public.risk_class not null default 'yellow',
  add constraint approvals_amount_nonnegative check (amount_cents is null or amount_cents >= 0),
  add constraint approvals_decision_consistent check (
    (status = 'pending' and decided_at is null)
    or status <> 'pending'
  );

alter table public.business_rules
  add column rule_key text not null default 'default',
  add constraint business_rules_version_positive check (version > 0);
create unique index business_rules_key_version_unique
  on public.business_rules(organization_id, action, rule_key, version);

alter table public.ops_cases
  add column sla_due_at timestamptz,
  add column automation_gap_category text,
  add column created_by_actor_type public.actor_type not null default 'system',
  add constraint ops_cases_priority_check check (priority in ('low', 'normal', 'high', 'urgent'));

alter table public.tasks
  add constraint tasks_status_check check (status in ('open', 'in_progress', 'done', 'cancelled')),
  add constraint tasks_priority_check check (priority in ('low', 'normal', 'high', 'urgent'));

alter table public.jobs
  add constraint jobs_status_check check (
    status in ('draft', 'scheduled', 'active', 'paused', 'completed', 'invoiced', 'closed')
  );

alter table public.documents
  add constraint documents_classification_check check (
    classification in ('public', 'internal', 'confidential', 'financial', 'employee_sensitive', 'credential_secret')
  );

-- A job may only reference a customer in its own organization (FKs alone do not check tenancy).
alter table public.customers add constraint customers_id_org_unique unique (id, organization_id);
alter table public.jobs drop constraint jobs_customer_id_fkey;
alter table public.jobs
  add constraint jobs_customer_same_org_fkey foreign key (customer_id, organization_id)
  references public.customers(id, organization_id) on delete set null (customer_id);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  body text not null check (char_length(body) between 1 and 4000),
  author_actor_type public.actor_type not null,
  author_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index memberships_user_idx on public.memberships(user_id);
create index customers_org_idx on public.customers(organization_id);
create index employees_org_idx on public.employees(organization_id);
create index vendors_org_idx on public.vendors(organization_id);
create index jobs_org_idx on public.jobs(organization_id);
create index tasks_org_status_idx on public.tasks(organization_id, status, priority);
create index approvals_org_status_idx on public.approvals(organization_id, status);
create index business_events_org_time_idx on public.business_events(organization_id, occurred_at desc);
create index audit_log_org_time_idx on public.audit_log(organization_id, created_at desc);
create index ops_cases_org_status_idx on public.ops_cases(organization_id, status);
create index notes_entity_idx on public.notes(organization_id, entity_type, entity_id);
create index operator_grants_operator_idx on public.internal_operator_grants(operator_user_id);

-- ---------------------------------------------------------------------------
-- 4. Authorization helpers (SECURITY DEFINER; answer questions about the caller only).
-- ---------------------------------------------------------------------------
create or replace function public.is_internal_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.internal_staff s
    where s.user_id = auth.uid() and s.active
  );
$$;

create or replace function public.has_operator_grant(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_internal_staff() and exists (
    select 1 from public.internal_operator_grants g
    where g.organization_id = org_id
      and g.operator_user_id = auth.uid()
      and g.revoked_at is null
      and g.expires_at > now()
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS policies.
-- ---------------------------------------------------------------------------
alter table public.internal_staff enable row level security;
alter table public.notes enable row level security;
-- 0001 left webhook_receipts without RLS; it is not a client-facing table.
alter table public.webhook_receipts enable row level security;

-- 0001's membership_select queried memberships from inside its own policy, which Postgres
-- rejects at query time ("infinite recursion detected in policy"). Use the definer helper.
drop policy membership_select on public.memberships;
create policy membership_select on public.memberships
for select to authenticated using (public.is_org_member(organization_id));

create policy org_operator_select on public.organizations
for select to authenticated using (public.has_operator_grant(id));

create policy internal_staff_self_select on public.internal_staff
for select to authenticated using (user_id = auth.uid());

-- Approvals: staff can read the queue; other members only see approvals they requested.
-- Decisions are server-only (no update policy), so they always produce event + audit.
drop policy approvals_member_select on public.approvals;
drop policy approvals_admin_update on public.approvals;
create policy approvals_select on public.approvals
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager','accountant_readonly']::public.membership_role[])
  or (
    public.is_org_member(organization_id)
    and requested_by_actor_type = 'user'
    and requested_by_actor_id = auth.uid()
  )
);

create policy business_rules_select on public.business_rules
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager','accountant_readonly']::public.membership_role[])
);

create policy business_events_select on public.business_events
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager','accountant_readonly']::public.membership_role[])
);

create policy audit_log_select on public.audit_log
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','accountant_readonly']::public.membership_role[])
);

create policy notes_select on public.notes
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager','accountant_readonly']::public.membership_role[])
);

create policy ops_cases_select on public.ops_cases
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[])
  or public.has_operator_grant(organization_id)
);

create policy operator_grants_select on public.internal_operator_grants
for select to authenticated using (
  operator_user_id = auth.uid()
  or public.has_org_role(organization_id, array['owner','office_admin']::public.membership_role[])
);

-- Staff write policies for record tables not covered by 0001.
create policy employees_staff_all on public.employees
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy tasks_staff_all on public.tasks
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy documents_staff_all on public.documents
for all to authenticated
using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
with check (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

-- ---------------------------------------------------------------------------
-- 6. Table privileges. RLS decides *which rows*; privileges decide *which operations*.
--    Supabase grants ALL on public tables to anon/authenticated by default; narrow that.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

revoke truncate, references, trigger on all tables in schema public from authenticated;

revoke insert, update, delete on
  public.organizations,
  public.memberships,
  public.approvals,
  public.business_rules,
  public.business_events,
  public.audit_log,
  public.internal_operator_grants,
  public.ops_cases,
  public.notes,
  public.internal_staff
from authenticated;

revoke all on public.webhook_receipts from authenticated;

-- ---------------------------------------------------------------------------
-- 7. Integrity triggers.
-- ---------------------------------------------------------------------------

-- Audit log and business events are append-only. A deliberate retention/erasure process may set
-- app.allow_append_only_maintenance = 'on' inside its own transaction.
create or replace function public.prevent_append_only_mutation()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.allow_append_only_maintenance', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.prevent_append_only_mutation();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.prevent_append_only_mutation();
create trigger business_events_append_only
  before update or delete on public.business_events
  for each row execute function public.prevent_append_only_mutation();
create trigger business_events_no_truncate
  before truncate on public.business_events
  for each statement execute function public.prevent_append_only_mutation();

-- Approvals: identity/amount are immutable; a decided approval can never change again.
-- This is the database backstop for decision idempotency.
create or replace function public.guard_approval_mutation()
returns trigger
language plpgsql
as $$
begin
  if (new.organization_id, new.type, new.amount_cents, new.currency, new.idempotency_key, new.risk_class)
     is distinct from
     (old.organization_id, old.type, old.amount_cents, old.currency, old.idempotency_key, old.risk_class) then
    raise exception 'approval % identity and amount are immutable', old.id using errcode = '42501';
  end if;
  if old.status <> 'pending'
     and (new.status, new.decided_at, new.decision_note) is distinct from (old.status, old.decided_at, old.decision_note) then
    raise exception 'approval % is already %', old.id, old.status using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger approvals_guard
  before update on public.approvals
  for each row execute function public.guard_approval_mutation();

-- Keep updated_at honest.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger organizations_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();
create trigger employees_updated_at before update on public.employees
  for each row execute function public.set_updated_at();
create trigger vendors_updated_at before update on public.vendors
  for each row execute function public.set_updated_at();
create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();
create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();
create trigger approvals_updated_at before update on public.approvals
  for each row execute function public.set_updated_at();
create trigger ops_cases_updated_at before update on public.ops_cases
  for each row execute function public.set_updated_at();

-- Row-mutation audit for client-writable tables. Records who changed what (column names only;
-- values are not copied so the audit log does not duplicate PII).
-- Actor comes from the JWT (auth.uid()); trusted server paths label non-user actors via
-- transaction-local settings app.actor_type / app.actor_label, which PostgREST clients cannot set.
create or replace function public.audit_row_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_old jsonb;
  v_changed text[];
  v_uid uuid := auth.uid();
  v_actor_type public.actor_type;
  v_entity_type text := tg_argv[0];
  v_verb text;
begin
  v_actor_type := coalesce(
    nullif(current_setting('app.actor_type', true), '')::public.actor_type,
    case when v_uid is null then 'system'::public.actor_type else 'user'::public.actor_type end
  );

  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
    v_verb := 'deleted';
  elsif tg_op = 'INSERT' then
    v_row := to_jsonb(new);
    v_verb := 'created';
  else
    v_row := to_jsonb(new);
    v_old := to_jsonb(old);
    v_verb := 'updated';
  end if;

  select coalesce(array_agg(k order by k), '{}')
    into v_changed
    from jsonb_object_keys(v_row) as k
   where k not in ('updated_at', 'created_at')
     and (v_old is null or (v_row -> k) is distinct from (v_old -> k));

  if tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return new;
  end if;

  insert into public.audit_log (organization_id, actor_type, actor_id, action, entity_type, entity_id, details)
  values (
    (v_row ->> 'organization_id')::uuid,
    v_actor_type,
    v_uid,
    v_entity_type || '.' || v_verb,
    v_entity_type,
    (v_row ->> 'id')::uuid,
    jsonb_build_object(
      'via', 'db_trigger',
      'changed_columns', to_jsonb(v_changed),
      'actor_label', nullif(current_setting('app.actor_label', true), '')
    )
  );
  return coalesce(new, old);
end;
$$;

revoke execute on function public.audit_row_mutation() from public, anon, authenticated;

create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function public.audit_row_mutation('customer');
create trigger employees_audit after insert or update or delete on public.employees
  for each row execute function public.audit_row_mutation('employee');
create trigger vendors_audit after insert or update or delete on public.vendors
  for each row execute function public.audit_row_mutation('vendor');
create trigger jobs_audit after insert or update or delete on public.jobs
  for each row execute function public.audit_row_mutation('job');
create trigger tasks_audit after insert or update or delete on public.tasks
  for each row execute function public.audit_row_mutation('task');
create trigger documents_audit after insert or update or delete on public.documents
  for each row execute function public.audit_row_mutation('document');
