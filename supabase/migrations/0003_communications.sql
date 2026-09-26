-- Back Office OS — M2 communications core
-- Extends 0001/0002 (treated as deployed; never edited). See docs/MASTER_SPEC.md §11.
--
-- Access model: communications are written by trusted server/integration code (webhook
-- ingestion, agent tools), never directly by clients — the same pattern as notes/ops_cases in
-- 0002. Members get RLS-filtered read access only; the app layer is responsible for the
-- event + audit records required by CLAUDE.md rule 8 (see M2-T09).

create type public.communication_channel as enum ('voice', 'sms', 'email');
create type public.communication_direction as enum ('inbound', 'outbound');
create type public.communication_participant_role as enum ('customer', 'employee', 'vendor', 'agent', 'unknown');

create table public.communications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel public.communication_channel not null,
  direction public.communication_direction not null,
  status text not null default 'in_progress',
  provider text,
  provider_conversation_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  summary text,
  transcript text,
  structured_extraction jsonb not null default '{}'::jsonb,
  retention_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint communications_status_check check (status in ('in_progress', 'completed', 'failed', 'abandoned')),
  constraint communications_retention_check check (retention_status in ('active', 'pending_deletion', 'deleted')),
  constraint communications_ended_after_started check (ended_at is null or ended_at >= started_at)
);
alter table public.communications add constraint communications_id_org_unique unique (id, organization_id);

-- A job may only reference a customer in its own org (0002 §3); employees/vendors need the same
-- guard so calls/messages/participants below can enforce same-org references via composite FKs.
alter table public.employees add constraint employees_id_org_unique unique (id, organization_id);
alter table public.vendors add constraint vendors_id_org_unique unique (id, organization_id);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  communication_id uuid not null,
  provider_call_id text,
  from_number text,
  to_number text,
  duration_seconds integer,
  recording_url text,
  disposition text,
  voicemail boolean not null default false,
  created_at timestamptz not null default now(),
  constraint calls_communication_unique unique (communication_id),
  constraint calls_communication_same_org_fkey foreign key (communication_id, organization_id)
    references public.communications(id, organization_id) on delete cascade,
  constraint calls_duration_nonnegative check (duration_seconds is null or duration_seconds >= 0)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  communication_id uuid not null,
  provider_message_id text,
  from_address text,
  to_address text,
  body text,
  media_urls jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint messages_communication_unique unique (communication_id),
  constraint messages_communication_same_org_fkey foreign key (communication_id, organization_id)
    references public.communications(id, organization_id) on delete cascade
);

create table public.communication_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  communication_id uuid not null,
  role public.communication_participant_role not null default 'unknown',
  customer_id uuid,
  employee_id uuid,
  vendor_id uuid,
  phone text,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  constraint communication_participants_communication_same_org_fkey foreign key (communication_id, organization_id)
    references public.communications(id, organization_id) on delete cascade,
  constraint communication_participants_customer_same_org_fkey foreign key (customer_id, organization_id)
    references public.customers(id, organization_id),
  constraint communication_participants_employee_same_org_fkey foreign key (employee_id, organization_id)
    references public.employees(id, organization_id),
  constraint communication_participants_vendor_same_org_fkey foreign key (vendor_id, organization_id)
    references public.vendors(id, organization_id),
  constraint communication_participants_single_reference check (
    (case when customer_id is not null then 1 else 0 end
     + case when employee_id is not null then 1 else 0 end
     + case when vendor_id is not null then 1 else 0 end) <= 1
  )
);

create index communications_org_time_idx on public.communications(organization_id, started_at desc);
create index calls_org_idx on public.calls(organization_id);
create index messages_org_idx on public.messages(organization_id);
create index communication_participants_org_comm_idx
  on public.communication_participants(organization_id, communication_id);
create index communication_participants_customer_idx
  on public.communication_participants(customer_id) where customer_id is not null;
create index communication_participants_employee_idx
  on public.communication_participants(employee_id) where employee_id is not null;
create index communication_participants_vendor_idx
  on public.communication_participants(vendor_id) where vendor_id is not null;

create trigger communications_updated_at before update on public.communications
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: member-read only. No client insert/update/delete policy — see header note.
-- ---------------------------------------------------------------------------
alter table public.communications enable row level security;
alter table public.calls enable row level security;
alter table public.messages enable row level security;
alter table public.communication_participants enable row level security;

create policy communications_select on public.communications
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[])
);
create policy calls_select on public.calls
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[])
);
create policy messages_select on public.messages
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[])
);
create policy communication_participants_select on public.communication_participants
for select to authenticated using (
  public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[])
);

revoke insert, update, delete on
  public.communications,
  public.calls,
  public.messages,
  public.communication_participants
from authenticated;
