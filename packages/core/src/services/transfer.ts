// M2-T13: agent/staff-callable warm transfer domain tool (MASTER_SPEC §8 GREEN action). Routed
// through a caller-supplied VoiceProvider so this package never imports a provider SDK (CLAUDE.md
// rules 9-10) — the structural shape below matches @backoffice/integrations' VoiceProvider.transferCall.

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

export type TransferCallProviderStatus = "queued" | "in_progress" | "transferred" | "failed";

export interface TransferCallProviderRequest {
  organizationId: UUID;
  providerCallId: string;
  toNumber: string;
  idempotencyKey: string;
}

export interface TransferCallProviderResult {
  providerCallId: string;
  status: TransferCallProviderStatus;
}

/** Matches @backoffice/integrations' VoiceProvider.transferCall without depending on it. */
export interface TransferCallProvider {
  transferCall(request: TransferCallProviderRequest): Promise<TransferCallProviderResult>;
}

export interface TransferCallResult {
  status: TransferCallProviderStatus;
  providerCallId: string;
  toEmployeeId: UUID;
}

/**
 * Load the active voice call for `communicationId`, scoped to the caller's organization. Only an
 * in-progress voice call with a known provider call id can be warm-transferred (policy check).
 */
async function loadTransferableCall(
  ctx: ServiceContext,
  communicationId: UUID,
): Promise<{ providerCallId: string }> {
  const { rows } = await ctx.tx.asService<Row>(
    `select calls.provider_call_id
       from public.communications c
       join public.calls on calls.communication_id = c.id
      where c.id = $1 and c.organization_id = $2 and c.channel = 'voice' and c.status = 'in_progress'`,
    [communicationId, ctx.organizationId],
  );
  const providerCallId = rows[0]?.provider_call_id;
  if (typeof providerCallId !== "string" || providerCallId.length === 0) {
    throw new NotFoundError("transferable call", communicationId);
  }
  return { providerCallId };
}

/**
 * Warm-transfer an in-progress call to an in-org employee. Idempotent per
 * (organization_id, idempotency_key): a retried call reuses the same provider request and writes
 * no second event.
 */
export async function transferCall(
  ctx: ServiceContext,
  provider: TransferCallProvider,
  input: TransferCallInput,
): Promise<TransferCallResult> {
  await ctx.authorize("communication.write");
  const data = parseInput(transferCallInput, input);
  const { providerCallId } = await loadTransferableCall(ctx, data.communicationId);

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

  const result = await provider.transferCall({
    organizationId: ctx.organizationId,
    providerCallId,
    toNumber: employee.phone,
    idempotencyKey: data.idempotencyKey,
  });

  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.communicationTransferred,
    entityType: "communication",
    entityId: data.communicationId,
    idempotencyKey: `communication.transferred:${ctx.organizationId}:${data.idempotencyKey}`,
    payload: { reason: data.reason, to_employee_id: employee.id, status: result.status },
  });
  await writeAudit(ctx, {
    action: "communication.transfer_requested",
    entityType: "communication",
    entityId: data.communicationId,
    sourceEventId: event.id,
    details: {
      reason: data.reason,
      to_employee_id: employee.id,
      provider_status: result.status,
      note: data.note ?? null,
    },
  });

  return {
    status: result.status,
    providerCallId: result.providerCallId,
    toEmployeeId: employee.id,
  };
}
