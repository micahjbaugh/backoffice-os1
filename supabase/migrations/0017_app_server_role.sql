-- Least-privilege application role.
--
-- Until now the app's own Postgres connection used the migration-owner role (`postgres`), which
-- owns every table and therefore bypasses RLS unconditionally, and can DROP/ALTER anything,
-- create roles, and read every schema. `app_server` replaces that connection for app traffic: it
-- owns nothing, cannot create or alter objects, is not a superuser, and does not carry the
-- BYPASSRLS attribute.
--
-- Two access modes, both already implemented in `Tx` (packages/core/src/db/tx.ts):
--   - `asUser`     -> `SET LOCAL ROLE authenticated` with the caller's JWT claims. Row access is
--     decided entirely by the existing per-table RLS policies ("create policy ... to
--     authenticated ..."); app_server's own grants are irrelevant here, because SET ROLE changes
--     current_user for the rest of the transaction.
--   - `asService`  -> stays as `app_server` itself, for the trusted server-side writes
--     (audit/events/decisions/webhook and outbox processing/etc.) that already run only after
--     code-level authorization has passed. Those need their own grants + policies below, scoped to
--     exactly the tables the service layer touches via `ctx.tx.asService` / `ServiceContext.scoped`
--     (see packages/core/src/services/*.ts).
--
-- The role's password/login is provisioned out of band, never committed here (see
-- docs/PRODUCTION_HARDENING.md).
create role app_server
  login
  noinherit
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls;

-- Lets app_server "SET LOCAL ROLE authenticated" for user-path queries. NOINHERIT means membership
-- alone grants nothing until it explicitly switches.
grant authenticated to app_server;

grant usage on schema public to app_server;
grant usage on schema auth to app_server;
-- Server code reads emails by user id (membership listing, add-member-by-email); auth.users is
-- otherwise managed entirely by Supabase Auth, so no insert/update/delete.
grant select on auth.users to app_server;

-- Every table the service layer writes to as a trusted actor: organization/membership creation,
-- audit, business events, approval decisions, ops console, webhook/outbound processing, and every
-- domain write made on behalf of a non-human actor via ServiceContext.scoped.
grant select, insert, update, delete on
  public.organizations,
  public.memberships,
  public.customers,
  public.employees,
  public.vendors,
  public.jobs,
  public.tasks,
  public.approvals,
  public.business_rules,
  public.business_events,
  public.audit_log,
  public.internal_operator_grants,
  public.ops_cases,
  public.documents,
  public.webhook_receipts,
  public.internal_staff,
  public.notes,
  public.communications,
  public.calls,
  public.messages,
  public.communication_participants,
  public.leads,
  public.lead_activities,
  public.equipment,
  public.time_entries,
  public.equipment_usages,
  public.material_usages,
  public.job_notes,
  public.billable_opportunities,
  public.provider_routes,
  public.outbound_operations
to app_server;

-- One permissive policy per table above: RLS still gates app_server (it is not the table owner and
-- carries NOBYPASSRLS), so without these it could read/write nothing. Tenant scoping on this path
-- is enforced in application code -- every service call carries an explicit organization_id and
-- calls ctx.authorize() before touching the database, exactly as it already was under the owner
-- connection. What changes is the blast radius: a leaked app_server credential cannot drop tables,
-- alter schema, create roles, or read/write anything outside this exact list.
create policy organizations_app_server_all on public.organizations for all to app_server using (true) with check (true);
create policy memberships_app_server_all on public.memberships for all to app_server using (true) with check (true);
create policy customers_app_server_all on public.customers for all to app_server using (true) with check (true);
create policy employees_app_server_all on public.employees for all to app_server using (true) with check (true);
create policy vendors_app_server_all on public.vendors for all to app_server using (true) with check (true);
create policy jobs_app_server_all on public.jobs for all to app_server using (true) with check (true);
create policy tasks_app_server_all on public.tasks for all to app_server using (true) with check (true);
create policy approvals_app_server_all on public.approvals for all to app_server using (true) with check (true);
create policy business_rules_app_server_all on public.business_rules for all to app_server using (true) with check (true);
create policy business_events_app_server_all on public.business_events for all to app_server using (true) with check (true);
create policy audit_log_app_server_all on public.audit_log for all to app_server using (true) with check (true);
create policy internal_operator_grants_app_server_all on public.internal_operator_grants for all to app_server using (true) with check (true);
create policy ops_cases_app_server_all on public.ops_cases for all to app_server using (true) with check (true);
create policy documents_app_server_all on public.documents for all to app_server using (true) with check (true);
create policy webhook_receipts_app_server_all on public.webhook_receipts for all to app_server using (true) with check (true);
create policy internal_staff_app_server_all on public.internal_staff for all to app_server using (true) with check (true);
create policy notes_app_server_all on public.notes for all to app_server using (true) with check (true);
create policy communications_app_server_all on public.communications for all to app_server using (true) with check (true);
create policy calls_app_server_all on public.calls for all to app_server using (true) with check (true);
create policy messages_app_server_all on public.messages for all to app_server using (true) with check (true);
create policy communication_participants_app_server_all on public.communication_participants for all to app_server using (true) with check (true);
create policy leads_app_server_all on public.leads for all to app_server using (true) with check (true);
create policy lead_activities_app_server_all on public.lead_activities for all to app_server using (true) with check (true);
create policy equipment_app_server_all on public.equipment for all to app_server using (true) with check (true);
create policy time_entries_app_server_all on public.time_entries for all to app_server using (true) with check (true);
create policy equipment_usages_app_server_all on public.equipment_usages for all to app_server using (true) with check (true);
create policy material_usages_app_server_all on public.material_usages for all to app_server using (true) with check (true);
create policy job_notes_app_server_all on public.job_notes for all to app_server using (true) with check (true);
create policy billable_opportunities_app_server_all on public.billable_opportunities for all to app_server using (true) with check (true);
create policy provider_routes_app_server_all on public.provider_routes for all to app_server using (true) with check (true);
create policy outbound_operations_app_server_all on public.outbound_operations for all to app_server using (true) with check (true);
