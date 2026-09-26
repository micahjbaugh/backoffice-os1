import {
  actorUserId,
  approvalDecidedIdempotencyKey,
  ConflictError,
  createApprovalInput,
  decideApprovalInput,
  evaluateApprovalDecision,
  EVENT_TYPES,
  ForbiddenError,
  NotFoundError,
  parseInput,
  type Approval,
  type BusinessEvent,
  type CreateApprovalInput,
  type DecideApprovalInput,
  type UUID,
} from "@backoffice/domain";
import { toApproval, toBusinessEvent, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { loadApprovalDelegationRules } from "./business-rules";
import { assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

export interface CreateApprovalResult {
  approval: Approval;
  /** False when the idempotency key matched an existing approval (nothing new written). */
  created: boolean;
}

/**
 * Request an approval (server/agent/member). Idempotent on (organization_id, idempotency_key):
 * retries return the original approval and emit no new event.
 */
export async function createApproval(
  ctx: ServiceContext,
  input: CreateApprovalInput,
): Promise<CreateApprovalResult> {
  await ctx.authorize("approval.request");
  const data = parseInput(createApprovalInput, input);
  await assertEntityInOrg(ctx, data.entityType, data.entityId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.approvals
       (organization_id, type, title, description, risk_class, amount_cents, currency,
        entity_type, entity_id, requested_by_actor_type, requested_by_actor_id, idempotency_key, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (organization_id, idempotency_key) do nothing
     returning *`,
    [
      ctx.organizationId,
      data.type,
      data.title,
      data.description ?? null,
      data.riskClass,
      data.amountCents ?? null,
      data.currency,
      data.entityType ?? null,
      data.entityId ?? null,
      ctx.actor.type,
      actorUserId(ctx.actor),
      data.idempotencyKey,
      data.expiresAt ?? null,
    ],
  );

  if (!rows[0]) {
    const existing = await ctx.tx.asService<Row>(
      `select * from public.approvals where organization_id = $1 and idempotency_key = $2`,
      [ctx.organizationId, data.idempotencyKey],
    );
    const approval = toApproval(existing.rows[0] as Row);
    if (approval.type !== data.type || approval.amountCents !== (data.amountCents ?? null)) {
      throw new ConflictError(
        "idempotency_key_reused",
        "Idempotency key reused for a different approval",
      );
    }
    return { approval, created: false };
  }

  const approval = toApproval(rows[0]);
  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.approvalRequested,
    entityType: "approval",
    entityId: approval.id,
    idempotencyKey: `approval.requested:${approval.id}`,
    payload: {
      approval_type: approval.type,
      risk_class: approval.riskClass,
      amount_cents: approval.amountCents,
      currency: approval.currency,
    },
  });
  await writeAudit(ctx, {
    action: "approval.created",
    entityType: "approval",
    entityId: approval.id,
    approvalId: approval.id,
    sourceEventId: event.id,
    details: {
      approval_type: approval.type,
      risk_class: approval.riskClass,
      amount_cents: approval.amountCents,
    },
  });
  return { approval, created: true };
}

export interface DecideApprovalResult {
  approval: Approval;
  event: BusinessEvent;
  /** True when this call repeated an already-applied identical decision; nothing was executed. */
  replayed: boolean;
}

/**
 * Approve or reject. Guarantees exactly-once execution:
 * row lock + `status = 'pending'` guard + unique `approval.decided:<id>` event key, backed by the
 * database trigger that makes decided approvals immutable.
 * A repeated identical decision (double click, retry) returns the original outcome with no side
 * effects; a conflicting decision throws ConflictError.
 */
export async function decideApproval(
  ctx: ServiceContext,
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  const data = parseInput(decideApprovalInput, input);
  const entity = { entityType: "approval", entityId: data.approvalId };
  const role = await ctx.authorize("approval.decide", entity);

  // Visibility through the actor's own security context (RLS for users).
  const visible = await ctx.scoped(
    `select 1 from public.approvals where id = $1 and organization_id = $2`,
    [data.approvalId, ctx.organizationId],
  );
  if (visible.rows.length === 0) throw new NotFoundError("approval", data.approvalId);

  const locked = await ctx.tx.asService<Row>(
    `select *, (expires_at is not null and expires_at <= now()) as is_expired
       from public.approvals
      where id = $1 and organization_id = $2
      for update`,
    [data.approvalId, ctx.organizationId],
  );
  const lockedRow = locked.rows[0];
  if (!lockedRow) throw new NotFoundError("approval", data.approvalId);
  const current = toApproval(lockedRow);

  const rules = await loadApprovalDelegationRules(ctx);
  const authority = evaluateApprovalDecision(ctx.actor, role, current, rules);
  if (!authority.allowed) {
    throw new ForbiddenError({
      action: "approval.decide",
      reason: authority.reason,
      organizationId: ctx.organizationId,
      ...entity,
    });
  }

  if (current.status !== "pending") {
    if (current.status === data.decision) {
      const prior = await ctx.tx.asService<Row>(
        `select * from public.business_events where organization_id = $1 and idempotency_key = $2`,
        [ctx.organizationId, approvalDecidedIdempotencyKey(current.id)],
      );
      if (prior.rows[0]) {
        return { approval: current, event: toBusinessEvent(prior.rows[0]), replayed: true };
      }
    }
    throw new ConflictError("approval_already_decided", `Approval is already ${current.status}`);
  }
  if (lockedRow.is_expired === true) {
    throw new ConflictError("approval_expired", "Approval has expired");
  }

  const decider = actorUserId(ctx.actor);
  const updated = await ctx.tx.asService<Row>(
    `update public.approvals
        set status = $3::public.approval_status,
            decided_by_user_id = $4,
            decided_at = now(),
            decision_note = $5
      where id = $1 and organization_id = $2 and status = 'pending'
      returning *`,
    [current.id, ctx.organizationId, data.decision, decider, data.note ?? null],
  );
  if (!updated.rows[0]) throw new ConflictError("approval_already_decided");
  const approval = toApproval(updated.rows[0]);

  const { event, created } = await recordEvent(ctx, {
    type: EVENT_TYPES.approvalDecided,
    entityType: "approval",
    entityId: approval.id,
    idempotencyKey: approvalDecidedIdempotencyKey(approval.id),
    payload: {
      decision: data.decision,
      approval_type: approval.type,
      risk_class: approval.riskClass,
      amount_cents: approval.amountCents,
      currency: approval.currency,
      policy_source: authority.policySource,
      has_note: data.note !== undefined,
    },
  });
  if (!created) throw new ConflictError("approval_already_decided");

  await writeAudit(ctx, {
    action: "approval.decided",
    entityType: "approval",
    entityId: approval.id,
    approvalId: approval.id,
    sourceEventId: event.id,
    details: {
      decision: data.decision,
      previous_status: "pending",
      decider_role: role,
      policy_source: authority.policySource,
    },
  });
  return { approval, event, replayed: false };
}

export async function listPendingApprovals(ctx: ServiceContext): Promise<Approval[]> {
  await ctx.authorize("approval.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.approvals
      where organization_id = $1
        and status = 'pending'
        and (expires_at is null or expires_at > now())
      order by case risk_class when 'red' then 0 when 'yellow' then 1 else 2 end, created_at`,
    [ctx.organizationId],
  );
  return rows.map(toApproval);
}

export async function getApproval(ctx: ServiceContext, approvalId: UUID): Promise<Approval> {
  await ctx.authorize("approval.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.approvals where id = $1 and organization_id = $2`,
    [approvalId, ctx.organizationId],
  );
  if (!rows[0]) throw new NotFoundError("approval", approvalId);
  return toApproval(rows[0]);
}
