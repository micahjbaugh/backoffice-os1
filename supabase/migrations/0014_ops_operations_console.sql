-- Back Office OS — Ops Console visibility into stuck webhook events and outbound operations
-- (M2-T24). Mirrors the ops_cases grant model (0002_m1_foundation.sql): internal staff see a
-- tenant's dead-lettered webhook events and failed/unknown outbound operations only with a live
-- grant for that organization. Unrouted webhook events (organization_id is null) belong to no
-- tenant yet, so they are read through the application's service role, never through this policy.

grant select on public.webhook_receipts to authenticated;
revoke insert, update, delete, truncate on public.webhook_receipts from authenticated, anon;

create policy webhook_receipts_operator_select on public.webhook_receipts
for select to authenticated using (
  organization_id is not null and public.has_operator_grant(organization_id)
);

create policy outbound_operations_operator_select on public.outbound_operations
for select to authenticated using (public.has_operator_grant(organization_id));
