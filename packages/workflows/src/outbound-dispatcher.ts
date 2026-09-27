// Executes queued outbound operations (foundation repair, finding 6).
//
//   claim (commit, lease)  ->  provider request (no DB transaction open)  ->  record outcome (commit)
//
// If the process dies between the provider request and recording the outcome, the lease expires and
// the operation becomes `unknown` (expireStaleOutboundLeases). Unknown operations are reconciled
// against the provider where that is possible (call transfers via GET /call; SMS via the delivery
// status callback, which carries the operation id), otherwise escalated once to a person. Nothing
// with an unknown outcome is re-sent automatically.

import {
  CALL_TRANSFER_OPERATION,
  claimOutboundOperations,
  expireStaleOutboundLeases,
  getOutboundOperation,
  inTenant,
  listUnknownOutboundOperations,
  reconcileOutboundOperation,
  recordEvent,
  recordMessage,
  recordOutboundOutcome,
  runAs,
  SMS_SEND_OPERATION,
  writeAudit,
  type Database,
  type OutboundOperation,
  type OutboundOutcome,
  type ServiceContext,
} from "@backoffice/core";
import { EVENT_TYPES, type Actor } from "@backoffice/domain";
import { ProviderRequestError, type ProviderRuntime } from "@backoffice/integrations";

export const OUTBOX_WORKER: Actor = { type: "system", name: "outbox-worker" };

type Success = Extract<OutboundOutcome, { kind: "succeeded" }>;

export interface OutboundExecutor {
  execute(op: OutboundOperation, runtime: ProviderRuntime): Promise<Success>;
  /** Ask the provider whether an `unknown` operation actually happened. */
  reconcile?(
    op: OutboundOperation,
    runtime: ProviderRuntime,
  ): Promise<Success | { kind: "unresolved"; detail: string }>;
  /** Domain follow-up recorded in the same transaction as the success. */
  onSucceeded?(ctx: ServiceContext, op: OutboundOperation, outcome: Success): Promise<void>;
}

const req = (op: OutboundOperation, key: string): string => {
  const value = op.request[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`operation ${op.id} request.${key} missing`);
  return value;
};

/** Record the outbound SMS as a communication once the provider has it (idempotent on the SID). */
async function recordOutboundSms(
  ctx: ServiceContext,
  op: OutboundOperation,
  providerMessageId: string,
  provider: string,
) {
  await recordMessage(ctx, {
    direction: "outbound",
    provider,
    providerConversationId: providerMessageId,
    status: "completed",
    providerMessageId,
    fromAddress: req(op, "fromNumber"),
    toAddress: req(op, "toNumber"),
    body: req(op, "body"),
  });
}

export const DEFAULT_EXECUTORS: Readonly<Record<string, OutboundExecutor>> = {
  [SMS_SEND_OPERATION]: {
    async execute(op, runtime) {
      const result = await runtime.sms.sendSMS({
        organizationId: op.organizationId,
        fromNumber: req(op, "fromNumber"),
        toNumber: req(op, "toNumber"),
        body: req(op, "body"),
        operationId: op.id,
      });
      return {
        kind: "succeeded",
        providerRef: result.providerMessageId,
        result: { status: result.status, provider: runtime.sms.provider },
      };
    },
    // Twilio's Messages API cannot be queried by our operation id; the status callback reconciles.
    async reconcile() {
      return { kind: "unresolved", detail: "no delivery status callback received for this send" };
    },
    async onSucceeded(ctx, op, outcome) {
      if (outcome.providerRef)
        await recordOutboundSms(
          ctx,
          op,
          outcome.providerRef,
          String(outcome.result.provider ?? op.provider ?? "sms"),
        );
    },
  },
  [CALL_TRANSFER_OPERATION]: {
    async execute(op, runtime) {
      const result = await runtime.voice.transferCall({
        organizationId: op.organizationId,
        providerCallId: req(op, "providerCallId"),
        toNumber: req(op, "toNumber"),
        operationId: op.id,
      });
      return {
        kind: "succeeded",
        providerRef: result.providerCallId,
        result: { status: result.status },
      };
    },
    async reconcile(op, runtime) {
      const call = await runtime.voice.getCall(req(op, "providerCallId"));
      if (call.status === "forwarding" || /forward|transfer/i.test(call.endedReason ?? "")) {
        return {
          kind: "succeeded",
          providerRef: call.providerCallId,
          result: { status: call.status, reconciled: true },
        };
      }
      return {
        kind: "unresolved",
        detail: `provider reports call status "${call.status}"${call.endedReason ? ` (${call.endedReason})` : ""}`,
      };
    },
    async onSucceeded(ctx, op) {
      const { event } = await recordEvent(ctx, {
        type: EVENT_TYPES.communicationTransferred,
        entityType: "communication",
        entityId: op.entityId ?? op.id,
        idempotencyKey: `communication.transferred:${op.id}`,
        payload: { operation_id: op.id, to_employee_id: op.request.toEmployeeId ?? null },
      });
      await writeAudit(ctx, {
        action: "communication.transferred",
        entityType: "communication",
        entityId: op.entityId ?? undefined,
        sourceEventId: event.id,
        details: { operation_id: op.id },
      });
    },
  },
};

function outcomeForError(error: unknown): OutboundOutcome {
  if (error instanceof ProviderRequestError) {
    return error.kind === "rejected"
      ? { kind: "rejected", retryable: error.retryable, error: error.message }
      : { kind: "ambiguous", error: error.message };
  }
  // A bug or unexpected exception after the request may have been sent: be conservative.
  return { kind: "ambiguous", error: error instanceof Error ? error.message : String(error) };
}

async function record(
  db: Database,
  op: OutboundOperation,
  outcome: OutboundOutcome,
  executor?: OutboundExecutor,
) {
  return runAs(db, OUTBOX_WORKER, async (tx) => {
    const { status, changed } = await recordOutboundOutcome(tx, op, outcome);
    // Follow-ups run only for the transition this worker made (not if a reconciliation won).
    if (
      changed &&
      status === "succeeded" &&
      outcome.kind === "succeeded" &&
      executor?.onSucceeded
    ) {
      await executor.onSucceeded(inTenant(tx, op.organizationId), op, outcome);
    }
    return status;
  });
}

export interface DispatchSummary {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  unknown: number;
}

/** Execute one batch of due operations. Safe to run from several workers at once. */
export async function dispatchOutboundOperations(
  db: Database,
  runtime: ProviderRuntime,
  opts: { limit?: number; executors?: Readonly<Record<string, OutboundExecutor>> } = {},
): Promise<DispatchSummary> {
  const executors = opts.executors ?? DEFAULT_EXECUTORS;
  const ops = await claimOutboundOperations(db, { limit: opts.limit ?? 10 });
  const summary: DispatchSummary = {
    claimed: ops.length,
    succeeded: 0,
    retrying: 0,
    failed: 0,
    unknown: 0,
  };
  for (const op of ops) {
    const executor = executors[op.operationType];
    let outcome: OutboundOutcome;
    if (!executor)
      outcome = {
        kind: "rejected",
        retryable: false,
        error: `no executor for ${op.operationType}`,
      };
    else {
      try {
        outcome = await executor.execute(op, runtime);
      } catch (error) {
        outcome = outcomeForError(error);
      }
    }
    const status = await record(db, op, outcome, executor);
    if (status === "succeeded") summary.succeeded += 1;
    else if (status === "pending") summary.retrying += 1;
    else if (status === "failed") summary.failed += 1;
    else summary.unknown += 1;
  }
  return summary;
}

/** Settle `unknown` operations: confirm with the provider or escalate once. Never re-sends. */
export async function reconcileUnknownOperations(
  db: Database,
  runtime: ProviderRuntime,
  opts: { executors?: Readonly<Record<string, OutboundExecutor>> } = {},
): Promise<{ reconciled: number; escalated: number }> {
  const executors = opts.executors ?? DEFAULT_EXECUTORS;
  await expireStaleOutboundLeases(db);
  const unknown = await listUnknownOutboundOperations(db);
  let reconciled = 0;
  let escalated = 0;
  for (const op of unknown) {
    const executor = executors[op.operationType];
    let finding: Awaited<ReturnType<NonNullable<OutboundExecutor["reconcile"]>>>;
    try {
      finding = executor?.reconcile
        ? await executor.reconcile(op, runtime)
        : { kind: "unresolved", detail: "no reconciliation available" };
    } catch (error) {
      finding = {
        kind: "unresolved",
        detail: `reconciliation check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const { status, changed } = await runAs(db, OUTBOX_WORKER, async (tx) => {
      const next = await reconcileOutboundOperation(tx, op, finding);
      if (
        next.changed &&
        next.status === "succeeded" &&
        finding.kind === "succeeded" &&
        executor?.onSucceeded
      ) {
        await executor.onSucceeded(inTenant(tx, op.organizationId), op, finding);
      }
      return next;
    });
    if (status === "succeeded") reconciled += 1;
    else if (changed) escalated += 1;
  }
  return { reconciled, escalated };
}

/**
 * Called from the SMS status webhook: a delivery callback for our operation proves Twilio accepted
 * the send. Settles an in-flight/unknown operation as succeeded and records the message.
 */
export async function reconcileSmsFromStatusCallback(
  ctx: ServiceContext,
  operationId: string,
  providerMessageId: string,
) {
  const op = await getOutboundOperation(ctx.tx, operationId).catch(() => null);
  if (!op || op.organizationId !== ctx.organizationId || op.operationType !== SMS_SEND_OPERATION)
    return;
  if (op.status !== "unknown" && op.status !== "in_flight") return;
  const outcome: Success = {
    kind: "succeeded",
    providerRef: providerMessageId,
    result: { reconciled_by: "status_callback" },
  };
  // Move the row from its actual current state (in_flight or unknown) to succeeded.
  const { status, changed } = await recordOutboundOutcome(ctx.tx, op, outcome);
  if (changed && status === "succeeded")
    await recordOutboundSms(ctx, op, providerMessageId, op.provider ?? "sms");
}
