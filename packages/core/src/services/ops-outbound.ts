// Ops console: operator visibility and remediation for failed/unknown outbound operations
// (M2-T24). Same access model as ops cases (./ops.ts): internal staff only, and only for
// organizations that currently grant them access.
//
// Retry is only ever offered for `failed` (the provider rejected the request, or retries ran out
// on a rejection: no side effect occurred). `unknown` operations (the provider may have acted) can
// never be retried directly; they must first be reconciled into a known state.

import { ConflictError, ForbiddenError, NotFoundError, type UUID } from "@backoffice/domain";
import type { Tx } from "../db/tx";
import { inTenant } from "../runtime";
import { writeAudit } from "./audit";
import {
  reconcileOutboundOperation,
  toOutboundOperation,
  type OutboundOperation,
} from "./outbound";
import { requireInternalStaff } from "./ops";
import { type Row } from "../rows";

export interface OperatorOutboundOperation extends OutboundOperation {
  organizationName: string;
}

export async function listStuckOutboundOperations(tx: Tx): Promise<OperatorOutboundOperation[]> {
  await requireInternalStaff(tx);
  const { rows } = await tx.asUser<Row>(
    `select b.*, o.name as organization_name
       from public.outbound_operations b join public.organizations o on o.id = b.organization_id
      where b.status in ('failed', 'unknown') and public.has_operator_grant(b.organization_id)
      order by b.updated_at`,
  );
  return rows.map((r) => ({
    ...toOutboundOperation(r),
    organizationName: String(r.organization_name),
  }));
}

async function loadGrantedOutboundOperation(
  tx: Tx,
  id: UUID,
  allowedStatuses: readonly OutboundOperation["status"][],
  action: string,
): Promise<OutboundOperation> {
  const { rows } = await tx.asUser<Row>(
    `select * from public.outbound_operations
      where id = $1 and public.has_operator_grant(organization_id)`,
    [id],
  );
  if (rows[0]) {
    const op = toOutboundOperation(rows[0]);
    if (!allowedStatuses.includes(op.status))
      throw new ConflictError("wrong_status", `Outbound operation ${id} is ${op.status}`);
    return op;
  }
  const exists = await tx.asService<{ organization_id: UUID }>(
    `select organization_id from public.outbound_operations where id = $1`,
    [id],
  );
  const orgId = exists.rows[0]?.organization_id;
  if (!orgId) throw new NotFoundError("outbound operation", id);
  throw new ForbiddenError({
    action,
    reason: "no_active_grant",
    organizationId: orgId,
    entityType: "outbound_operation",
    entityId: id,
  });
}

/** Never offered for `unknown` operations: the provider may already have acted. */
export async function retryFailedOutboundOperation(tx: Tx, id: UUID): Promise<OutboundOperation> {
  await requireInternalStaff(tx);
  const op = await loadGrantedOutboundOperation(tx, id, ["failed"], "outbound_operation.retry");
  const { rows } = await tx.asService<Row>(
    `update public.outbound_operations
        set status = 'pending', attempts = 0, next_attempt_at = now(), lease_expires_at = null
      where id = $1 and status = 'failed'
      returning *`,
    [id],
  );
  if (!rows[0])
    throw new ConflictError("wrong_status", `Outbound operation ${id} is no longer failed`);
  await writeAudit(inTenant(tx, op.organizationId), {
    action: "outbound_operation.retried",
    entityType: "outbound_operation",
    entityId: id,
    details: { operation_type: op.operationType, previous_attempts: op.attempts },
  });
  return toOutboundOperation(rows[0]);
}

export async function cancelOutboundOperation(tx: Tx, id: UUID): Promise<OutboundOperation> {
  await requireInternalStaff(tx);
  const op = await loadGrantedOutboundOperation(
    tx,
    id,
    ["pending", "failed", "unknown"],
    "outbound_operation.cancel",
  );
  const { rows } = await tx.asService<Row>(
    `update public.outbound_operations
        set status = 'cancelled', completed_at = now(), lease_expires_at = null
      where id = $1 and status = $2
      returning *`,
    [id, op.status],
  );
  if (!rows[0]) throw new ConflictError("wrong_status", `Outbound operation ${id} already changed`);
  await writeAudit(inTenant(tx, op.organizationId), {
    action: "outbound_operation.cancelled",
    entityType: "outbound_operation",
    entityId: id,
    details: { operation_type: op.operationType, previous_status: op.status },
  });
  return toOutboundOperation(rows[0]);
}

export type ReconcileFinding =
  { kind: "succeeded"; providerRef: string | null } | { kind: "did_not_happen" };

/** Resolve an `unknown` operation into a known state once a person has checked with the provider. */
export async function reconcileUnknownOutboundOperation(
  tx: Tx,
  id: UUID,
  finding: ReconcileFinding,
): Promise<OutboundOperation> {
  await requireInternalStaff(tx);
  const op = await loadGrantedOutboundOperation(
    tx,
    id,
    ["unknown"],
    "outbound_operation.reconcile",
  );
  const ctx = inTenant(tx, op.organizationId);
  if (finding.kind === "succeeded") {
    await reconcileOutboundOperation(tx, op, {
      kind: "succeeded",
      providerRef: finding.providerRef,
      result: { reconciled_by: "operator" },
    });
  } else {
    const { rowCount } = await tx.asService(
      `update public.outbound_operations
          set status = 'failed', last_error = 'confirmed with the provider: it did not happen',
              completed_at = now(), lease_expires_at = null
        where id = $1 and status = 'unknown'`,
      [id],
    );
    if (rowCount === 0)
      throw new ConflictError("wrong_status", `Outbound operation ${id} is no longer unknown`);
  }
  await writeAudit(ctx, {
    action: "outbound_operation.reconciled",
    entityType: "outbound_operation",
    entityId: id,
    details: { operation_type: op.operationType, finding: finding.kind },
  });
  const { rows } = await tx.asService<Row>(
    `select * from public.outbound_operations where id = $1`,
    [id],
  );
  return toOutboundOperation(rows[0] as Row);
}
