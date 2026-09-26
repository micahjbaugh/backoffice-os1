// Outbound operations (outbox) — foundation repair, finding 6.
//
// A provider side effect (send an SMS, transfer a call) is recorded as an outbound_operations row in
// the SAME transaction as the domain change that wants it, and executed later by a worker outside any
// database transaction. States:
//
//   pending --claim--> in_flight --> succeeded
//                         |--> pending (provider definitely did not act; retryable; bounded)
//                         |--> failed  (provider refused; not retryable, or retries exhausted)
//                         '--> unknown (provider MAY have acted: timeout, 5xx, crash with lease expired)
//   unknown --reconcile--> succeeded | (still unknown -> escalated to a person via an ops case)
//
// We do not claim exactly-once external execution: Twilio's Messages API and Vapi's call control API
// accept no request idempotency key. What we guarantee is at-most-once *attempts* for any request
// whose outcome is unknown: those are never retried automatically.

import { createHash } from "node:crypto";
import { ConflictError, EVENT_TYPES, type UUID } from "@backoffice/domain";
import type { Database } from "../db/types";
import type { Tx } from "../db/tx";
import { iso, isoOrNull, type Row } from "../rows";
import { inTenant, type ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { recordEvent } from "./events";
import { createOpsCase } from "./ops";

export type OutboundStatus =
  "pending" | "in_flight" | "succeeded" | "failed" | "unknown" | "cancelled";

export interface OutboundOperation {
  id: UUID;
  organizationId: UUID;
  operationType: string;
  idempotencyKey: string;
  requestHash: string;
  request: Record<string, unknown>;
  status: OutboundStatus;
  provider: string | null;
  providerRef: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
  entityType: string | null;
  entityId: UUID | null;
  opsCaseId: UUID | null;
  createdAt: string;
  completedAt: string | null;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "string"
    ? (JSON.parse(v) as Record<string, unknown>)
    : ((v ?? {}) as Record<string, unknown>);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const toOutboundOperation = (r: Row): OutboundOperation => ({
  id: String(r.id),
  organizationId: String(r.organization_id),
  operationType: String(r.operation_type),
  idempotencyKey: String(r.idempotency_key),
  requestHash: String(r.request_hash),
  request: obj(r.request),
  status: String(r.status) as OutboundStatus,
  provider: s(r.provider),
  providerRef: s(r.provider_ref),
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  nextAttemptAt: iso(r.next_attempt_at),
  leaseExpiresAt: isoOrNull(r.lease_expires_at),
  lastError: s(r.last_error),
  result: r.result === null || r.result === undefined ? null : obj(r.result),
  entityType: s(r.entity_type),
  entityId: s(r.entity_id),
  opsCaseId: s(r.ops_case_id),
  createdAt: iso(r.created_at),
  completedAt: isoOrNull(r.completed_at),
});

/** Stable JSON (sorted keys) so equal requests hash equally regardless of key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface EnqueueOutboundInput {
  operationType: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
  provider?: string;
  entityType?: string;
  entityId?: UUID;
  maxAttempts?: number;
}

/**
 * Record intent to perform a provider side effect, in the caller's transaction. The caller must
 * have authorized the domain action already. Keys are scoped to (organization, operation type); the
 * same key with a different request is a ConflictError, never a silent second action.
 */
export async function enqueueOutboundOperation(
  ctx: ServiceContext,
  input: EnqueueOutboundInput,
): Promise<{ operation: OutboundOperation; created: boolean }> {
  const requestHash = createHash("sha256").update(stableStringify(input.request)).digest("hex");
  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.outbound_operations
       (organization_id, operation_type, idempotency_key, request_hash, request, provider,
        entity_type, entity_id, max_attempts, created_by_actor_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (organization_id, operation_type, idempotency_key) do nothing
     returning *`,
    [
      ctx.organizationId,
      input.operationType,
      input.idempotencyKey,
      requestHash,
      JSON.stringify(input.request),
      input.provider ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      input.maxAttempts ?? 5,
      ctx.actor.type,
    ],
  );
  if (rows[0]) return { operation: toOutboundOperation(rows[0]), created: true };

  const existing = await ctx.tx.asService<Row>(
    `select * from public.outbound_operations
      where organization_id = $1 and operation_type = $2 and idempotency_key = $3`,
    [ctx.organizationId, input.operationType, input.idempotencyKey],
  );
  const operation = toOutboundOperation(existing.rows[0] as Row);
  if (operation.requestHash !== requestHash) {
    throw new ConflictError(
      "idempotency_key_reused",
      "Idempotency key reused for a different request",
    );
  }
  return { operation, created: false };
}

/** Claim due pending operations for execution; each claim is one attempt and takes a lease. */
export async function claimOutboundOperations(
  db: Database,
  opts: { limit?: number; leaseSeconds?: number } = {},
): Promise<OutboundOperation[]> {
  return db.transaction(async (exec) => {
    const { rows } = await exec.query<Row>(
      `update public.outbound_operations
          set status = 'in_flight', attempts = attempts + 1,
              lease_expires_at = now() + make_interval(secs => $2)
        where id in (
          select id from public.outbound_operations
           where status = 'pending' and next_attempt_at <= now()
           order by next_attempt_at, created_at
           for update skip locked
           limit $1)
        returning *`,
      [opts.limit ?? 10, opts.leaseSeconds ?? 60],
    );
    return rows.map(toOutboundOperation);
  });
}

/** Retry delay after the Nth rejected attempt: 30s, 60s, 120s ... capped at 30 minutes. */
export function outboundRetryDelaySeconds(attempts: number): number {
  return Math.min(1800, 30 * 2 ** Math.max(0, attempts - 1));
}

export type OutboundOutcome =
  | { kind: "succeeded"; providerRef: string | null; result: Record<string, unknown> }
  | { kind: "rejected"; retryable: boolean; error: string }
  | { kind: "ambiguous"; error: string };

async function escalate(
  ctx: ServiceContext,
  op: OutboundOperation,
  title: string,
  error: string,
): Promise<UUID> {
  const opsCase = await createOpsCase(ctx, {
    title,
    reasonCode: "integration_failure",
    priority: "high",
    evidence: {
      operation_id: op.id,
      operation_type: op.operationType,
      status: op.status,
      attempts: op.attempts,
      error,
      entity_type: op.entityType,
      entity_id: op.entityId,
    },
  });
  return opsCase.id;
}

export interface OutcomeRecord {
  status: OutboundStatus;
  /** False when the operation had already moved on (another worker or a reconciliation won). */
  changed: boolean;
}

/**
 * Record what happened to an in-flight operation. Only succeeds if the operation is still in the
 * state this worker claimed (guards against a late worker overwriting a reconciled result).
 */
export async function recordOutboundOutcome(
  tx: Tx,
  op: OutboundOperation,
  outcome: OutboundOutcome,
): Promise<OutcomeRecord> {
  const ctx = inTenant(tx, op.organizationId);
  const fromStatus = op.status;

  if (outcome.kind === "succeeded") {
    const { rowCount } = await tx.asService(
      `update public.outbound_operations
          set status = 'succeeded', provider_ref = $3, result = $4, last_error = null,
              lease_expires_at = null, completed_at = now()
        where id = $1 and status = $2`,
      [op.id, fromStatus, outcome.providerRef, JSON.stringify(outcome.result)],
    );
    if (rowCount === 0)
      return { status: (await getOutboundOperation(tx, op.id)).status, changed: false };
    const { event } = await recordEvent(ctx, {
      type: EVENT_TYPES.outboundSucceeded,
      entityType: op.entityType ?? "outbound_operation",
      entityId: op.entityId ?? op.id,
      idempotencyKey: `outbound.succeeded:${op.id}`,
      payload: {
        operation_id: op.id,
        operation_type: op.operationType,
        provider_ref: outcome.providerRef,
      },
    });
    await writeAudit(ctx, {
      action: `outbound.${op.operationType}.succeeded`,
      entityType: "outbound_operation",
      entityId: op.id,
      sourceEventId: event.id,
      details: { attempts: op.attempts, provider_ref: outcome.providerRef },
    });
    return { status: "succeeded", changed: true };
  }

  if (outcome.kind === "rejected" && outcome.retryable && op.attempts < op.maxAttempts) {
    const retry = await tx.asService(
      `update public.outbound_operations
          set status = 'pending', last_error = $3, lease_expires_at = null,
              next_attempt_at = now() + make_interval(secs => $4)
        where id = $1 and status = $2`,
      [op.id, fromStatus, outcome.error.slice(0, 2000), outboundRetryDelaySeconds(op.attempts)],
    );
    if (retry.rowCount === 0)
      return { status: (await getOutboundOperation(tx, op.id)).status, changed: false };
    return { status: "pending", changed: true };
  }

  const status: OutboundStatus = outcome.kind === "ambiguous" ? "unknown" : "failed";
  const { rowCount } = await tx.asService(
    `update public.outbound_operations
        set status = $3, last_error = $4, lease_expires_at = null,
            completed_at = case when $3 = 'failed' then now() else completed_at end
      where id = $1 and status = $2`,
    [op.id, fromStatus, status, outcome.error.slice(0, 2000)],
  );
  if (rowCount === 0)
    return { status: (await getOutboundOperation(tx, op.id)).status, changed: false };
  await writeAudit(ctx, {
    action: `outbound.${op.operationType}.${status}`,
    entityType: "outbound_operation",
    entityId: op.id,
    details: { attempts: op.attempts, error: outcome.error.slice(0, 500) },
  });
  if (status === "failed") {
    const opsCaseId = await escalate(ctx, op, `Outbound ${op.operationType} failed`, outcome.error);
    await tx.asService(`update public.outbound_operations set ops_case_id = $2 where id = $1`, [
      op.id,
      opsCaseId,
    ]);
  }
  return { status, changed: true };
}

/**
 * Operations whose worker lease expired while in flight (crash, deploy, timeout mid-request): the
 * provider may or may not have acted, so they become `unknown`, never `pending`.
 */
export async function expireStaleOutboundLeases(db: Database): Promise<OutboundOperation[]> {
  return db.transaction(async (exec) => {
    const { rows } = await exec.query<Row>(
      `update public.outbound_operations
          set status = 'unknown', lease_expires_at = null,
              last_error = coalesce(last_error, 'worker lease expired while in flight; outcome unknown')
        where status = 'in_flight' and lease_expires_at < now()
        returning *`,
    );
    return rows.map(toOutboundOperation);
  });
}

export async function listUnknownOutboundOperations(
  db: Database,
  limit = 25,
): Promise<OutboundOperation[]> {
  return db.transaction(async (exec) => {
    const { rows } = await exec.query<Row>(
      `select * from public.outbound_operations where status = 'unknown' order by updated_at limit $1`,
      [limit],
    );
    return rows.map(toOutboundOperation);
  });
}

/**
 * Settle an `unknown` operation: `succeeded` when the provider confirms it acted; otherwise it stays
 * unknown and, once, a person is asked to check (ops case). Never re-sent automatically.
 */
export async function reconcileOutboundOperation(
  tx: Tx,
  op: OutboundOperation,
  finding:
    | { kind: "succeeded"; providerRef: string | null; result: Record<string, unknown> }
    | { kind: "unresolved"; detail: string },
): Promise<OutcomeRecord> {
  if (finding.kind === "succeeded")
    return recordOutboundOutcome(tx, { ...op, status: "unknown" }, finding);
  if (op.opsCaseId) return { status: "unknown", changed: false };
  const ctx = inTenant(tx, op.organizationId);
  const opsCaseId = await escalate(
    ctx,
    op,
    `Outbound ${op.operationType} outcome unknown: check with the provider before retrying`,
    `${op.lastError ?? ""} ${finding.detail}`.trim(),
  );
  await tx.asService(
    `update public.outbound_operations set ops_case_id = $2 where id = $1 and ops_case_id is null`,
    [op.id, opsCaseId],
  );
  await writeAudit(ctx, {
    action: `outbound.${op.operationType}.escalated`,
    entityType: "outbound_operation",
    entityId: op.id,
    details: { reason: finding.detail },
  });
  return { status: "unknown", changed: true };
}

export async function getOutboundOperation(tx: Tx, id: UUID): Promise<OutboundOperation> {
  const { rows } = await tx.asService<Row>(
    `select * from public.outbound_operations where id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error(`outbound operation ${id} not found`);
  return toOutboundOperation(rows[0]);
}
