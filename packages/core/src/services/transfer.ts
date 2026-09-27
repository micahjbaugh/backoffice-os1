// Warm transfer (M2-T13, reworked in the foundation repair, finding 6).
//
// This service decides and records; it does not call the provider. In one transaction it validates
// the call and target, queues a `call.transfer` outbound operation, and writes the
// `communication.transfer_requested` event + audit. The outbox worker (packages/workflows) performs
// the provider request outside any database transaction and records `communication.transferred`
// when the provider confirms it. A crash or timeout mid-transfer leaves the operation `unknown` for
// reconciliation; it is never re-sent blindly.

import {
  ConflictError,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  transferCallInput,
  type TransferCallInput,
  type UUID,
} from "@backoffice/domain";
import { toEmployee, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { recordEvent } from "./events";
import { enqueueOutboundOperation, type OutboundStatus } from "./outbound";

export const CALL_TRANSFER_OPERATION = "call.transfer";

export interface TransferCallResult {
  operationId: UUID;
  /** Outbox status: `pending` right after the request; later `succeeded` / `failed` / `unknown`. */
  status: OutboundStatus;
  providerCallId: string;
  toEmployeeId: UUID;
  /** False when this idempotency key was already used for the same transfer (nothing new queued). */
  created: boolean;
}

async function loadTransferableCall(
  ctx: ServiceContext,
  communicationId: UUID,
): Promise<{ providerCallId: string; provider: string | null }> {
  const { rows } = await ctx.tx.asService<Row>(
    `select calls.provider_call_id, c.provider
       from public.communications c
       join public.calls on calls.communication_id = c.id
      where c.id = $1 and c.organization_id = $2 and c.channel = 'voice' and c.status = 'in_progress'`,
    [communicationId, ctx.organizationId],
  );
  const providerCallId = rows[0]?.provider_call_id;
  if (typeof providerCallId !== "string" || providerCallId.length === 0) {
    throw new NotFoundError("transferable call", communicationId);
  }
  return {
    providerCallId,
    provider: typeof rows[0]?.provider === "string" ? rows[0].provider : null,
  };
}

/** Request a warm transfer of an in-progress call to an in-org employee. Idempotent per key. */
export async function transferCall(
  ctx: ServiceContext,
  input: TransferCallInput,
): Promise<TransferCallResult> {
  await ctx.authorize("communication.write");
  const data = parseInput(transferCallInput, input);
  const { providerCallId, provider } = await loadTransferableCall(ctx, data.communicationId);

  const { rows } = await ctx.tx.asService<Row>(
    `select * from public.employees where id = $1 and organization_id = $2`,
    [data.toEmployeeId, ctx.organizationId],
  );
  const employeeRow = rows[0];
  if (!employeeRow) throw new NotFoundError("employee", data.toEmployeeId);
  const employee = toEmployee(employeeRow);
  if (!employee.phone) {
    throw new ConflictError(
      "employee_has_no_transfer_number",
      `Employee ${employee.id} has no phone number on file`,
    );
  }

  const { operation, created } = await enqueueOutboundOperation(ctx, {
    operationType: CALL_TRANSFER_OPERATION,
    idempotencyKey: data.idempotencyKey,
    provider: provider ?? undefined,
    entityType: "communication",
    entityId: data.communicationId,
    request: {
      providerCallId,
      toNumber: employee.phone,
      toEmployeeId: employee.id,
      reason: data.reason,
    },
  });

  if (created) {
    const { event } = await recordEvent(ctx, {
      type: EVENT_TYPES.communicationTransferRequested,
      entityType: "communication",
      entityId: data.communicationId,
      idempotencyKey: `communication.transfer_requested:${operation.id}`,
      payload: { reason: data.reason, to_employee_id: employee.id, operation_id: operation.id },
    });
    await writeAudit(ctx, {
      action: "communication.transfer_requested",
      entityType: "communication",
      entityId: data.communicationId,
      sourceEventId: event.id,
      details: {
        reason: data.reason,
        to_employee_id: employee.id,
        operation_id: operation.id,
        note: data.note ?? null,
      },
    });
  }

  return {
    operationId: operation.id,
    status: operation.status,
    providerCallId,
    toEmployeeId: employee.id,
    created,
  };
}
