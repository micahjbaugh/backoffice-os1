-- Back Office OS — durable webhook ingestion and outbound operations (foundation repair,
-- findings 3, 5, 6).
--
--   * provider_routes: trusted tenant resolution. A webhook's organization comes from the number or
--     provider resource it was sent to, never from anything the caller or payload claims.
--   * webhook_receipts gains a real event identity (distinct from the call/message it describes), a
--     delivery id for retries, the validated payload needed for recovery, and a processing state
--     machine with bounded retries.
--   * communications get a uniqueness guarantee per provider conversation so concurrent deliveries
--     cannot create duplicates; messages get a monotonic delivery status.
--   * outbound_operations: an outbox for provider side effects (send SMS, transfer call). Intent is
--     recorded in the same transaction as the domain change; a worker executes it outside any
--     transaction and records the outcome. Ambiguous outcomes are held for reconciliation, never
--     retried blindly.

-- ---------------------------------------------------------------------------
-- 1. Provider routes (tenant resolution).
-- ---------------------------------------------------------------------------
create table public.provider_routes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  channel public.communication_channel not null,
  -- E.164 phone number or provider resource id (e.g. a Vapi phone number id).
  address text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint provider_routes_address_nonempty check (char_length(address) between 1 and 200)
);
create unique index provider_routes_active_address_unique
  on public.provider_routes(provider, address) where active;
create index provider_routes_org_idx on public.provider_routes(organization_id);

alter table public.provider_routes enable row level security;
create policy provider_routes_staff_select on public.provider_routes for select to authenticated
  using (public.has_org_role(organization_id, array['owner','office_admin']::public.membership_role[]));
revoke insert, update, delete, truncate on public.provider_routes from authenticated, anon;

create trigger provider_routes_audit after insert or update or delete on public.provider_routes
  for each row execute function public.audit_row_mutation('provider_route');

-- ---------------------------------------------------------------------------
-- 2. Webhook event store.
--    provider_event_id now holds the derived EVENT identity (e.g. "SM123:delivered"), not the
--    resource id; resource_id holds the call/message the event is about.
-- ---------------------------------------------------------------------------
alter table public.webhook_receipts
  add column event_type text,
  add column resource_id text,
  add column delivery_id text,
  add column occurred_at timestamptz,
  add column payload jsonb,
  add column payload_classification text not null default 'confidential',
  add column attempts integer not null default 0,
  add column max_attempts integer not null default 8,
  add column next_attempt_at timestamptz,
  add column locked_until timestamptz,
  add column last_error text,
  add column delivery_count integer not null default 1,
  add column last_delivery_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add constraint webhook_receipts_status_check check (
    status in ('received', 'processing', 'processed', 'failed', 'dead', 'ignored', 'unroutable')
  ),
  add constraint webhook_receipts_attempts_nonnegative check (attempts >= 0);

create index webhook_receipts_ready_idx
  on public.webhook_receipts(status, next_attempt_at)
  where status in ('received', 'failed', 'processing');
create index webhook_receipts_resource_idx on public.webhook_receipts(provider, resource_id);

create trigger webhook_receipts_updated_at before update on public.webhook_receipts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Communications: one envelope per provider conversation; monotonic message delivery status.
-- ---------------------------------------------------------------------------
create unique index communications_provider_conversation_unique
  on public.communications(organization_id, provider, provider_conversation_id)
  where provider is not null and provider_conversation_id is not null;

alter table public.messages
  add column delivery_status text,
  add column delivery_status_rank integer not null default 0,
  add column delivery_error_code text;
create index messages_provider_message_idx on public.messages(provider_message_id)
  where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Outbound operations (outbox).
-- ---------------------------------------------------------------------------
create table public.outbound_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  operation_type text not null,
  idempotency_key text not null,
  request_hash text not null,
  request jsonb not null,
  status text not null default 'pending',
  provider text,
  provider_ref text,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error text,
  result jsonb,
  entity_type text,
  entity_id uuid,
  ops_case_id uuid references public.ops_cases(id) on delete set null,
  created_by_actor_type public.actor_type not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint outbound_operations_status_check check (
    status in ('pending', 'in_flight', 'succeeded', 'failed', 'unknown', 'cancelled')
  ),
  constraint outbound_operations_attempts_nonnegative check (attempts >= 0),
  constraint outbound_operations_key_unique unique (organization_id, operation_type, idempotency_key)
);
create index outbound_operations_ready_idx
  on public.outbound_operations(status, next_attempt_at) where status in ('pending', 'in_flight');

create trigger outbound_operations_updated_at before update on public.outbound_operations
  for each row execute function public.set_updated_at();

alter table public.outbound_operations enable row level security;
create policy outbound_operations_staff_select on public.outbound_operations for select to authenticated
  using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
revoke insert, update, delete, truncate on public.outbound_operations from authenticated, anon;
