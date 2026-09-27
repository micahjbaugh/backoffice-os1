// Decisions on draft records (foundation repair, finding 7). Clients can create and edit drafts, but
// only these services change `status` (0011_draft_decision_authority.sql revokes the column), so
// every approval or rejection goes through code-level authorization and leaves an event + audit.
//
// Authority:
//   - time entries, equipment usage, material usage: owner, office_admin, manager
//     ("draft_record.decide"; matches the M7 time-approval plan);
//   - billable opportunities: the approval policy (evaluateApprovalDecision) treats approving
//     extra billable work as a financial "change_order": owner, or office_admin only where a
//     business rule delegates it. Managers never decide these.
// A repeated identical decision is a no-op replay; a conflicting one is a ConflictError.

import {
  actorUserId,
  ConflictError,
  decideBillableOpportunityInput,
  decideDraftRecordInput,
  evaluateApprovalDecision,
  EVENT_TYPES,
  ForbiddenError,
  NotFoundError,
  parseInput,
  type BillableOpportunity,
  type DecidableDraftKind,
  type DecideBillableOpportunityInput,
  type DecideDraftRecordInput,
  type EquipmentUsage,
  type MaterialUsage,
  type TimeEntry,
} from "@backoffice/domain";
import {
  toBillableOpportunity,
  toEquipmentUsage,
  toMaterialUsage,
  toTimeEntry,
  type Row,
} from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { loadApprovalDelegationRules } from "./business-rules";
import { recordEvent } from "./events";

type DraftRecord = TimeEntry | EquipmentUsage | MaterialUsage;

const DRAFT_TABLES: Readonly<
  Record<DecidableDraftKind, { table: string; map: (r: Row) => DraftRecord }>
> = {
  time_entry: { table: "public.time_entries", map: toTimeEntry },
  equipment_usage: { table: "public.equipment_usages", map: toEquipmentUsage },
  material_usage: { table: "public.material_usages", map: toMaterialUsage },
};

/** The policy subject for approving extra billable work (always financial). */
export const BILLABLE_OPPORTUNITY_POLICY_SUBJECT = {
  type: "change_order",
  riskClass: "yellow" as const,
  amountCents: null,
};

export interface DraftDecisionResult<T> {
  record: T;
  /** True when this call repeated an already-applied identical decision; nothing was written. */
  replayed: boolean;
}

export async function decideDraftRecord(
  ctx: ServiceContext,
  input: DecideDraftRecordInput,
): Promise<DraftDecisionResult<DraftRecord>> {
  const data = parseInput(decideDraftRecordInput, input);
  const entity = { entityType: data.kind, entityId: data.id };
  await ctx.authorize("draft_record.decide", entity);
  const decider = actorUserId(ctx.actor);
  if (ctx.actor.type !== "user" || !decider) {
    throw new ForbiddenError({
      action: "draft_record.decide",
      reason: "only_human_members_decide",
      organizationId: ctx.organizationId,
      ...entity,
    });
  }

  const { table, map } = DRAFT_TABLES[data.kind];
  const locked = await ctx.tx.asService<Row>(
    `select * from ${table} where id = $1 and organization_id = $2 for update`,
    [data.id, ctx.organizationId],
  );
  if (!locked.rows[0]) throw new NotFoundError(data.kind, data.id);
  const current = map(locked.rows[0]);

  if (current.status !== "draft") {
    if (current.status === data.decision) return { record: current, replayed: true };
    throw new ConflictError("already_decided", `${data.kind} is already ${current.status}`);
  }

  const updated = await ctx.tx.asService<Row>(
    `update ${table}
        set status = $3, decided_by_user_id = $4, decided_at = now(), decision_note = $5
      where id = $1 and organization_id = $2 and status = 'draft'
      returning *`,
    [data.id, ctx.organizationId, data.decision, decider, data.note ?? null],
  );
  const record = map(updated.rows[0] as Row);

  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.draftRecordDecided,
    entityType: data.kind,
    entityId: record.id,
    idempotencyKey: `draft_record.decided:${data.kind}:${record.id}`,
    payload: { kind: data.kind, decision: data.decision, has_note: data.note !== undefined },
  });
  await writeAudit(ctx, {
    action: `${data.kind}.${data.decision}`,
    entityType: data.kind,
    entityId: record.id,
    sourceEventId: event.id,
    details: { decision: data.decision, previous_status: "draft", decider_role: await ctx.role() },
  });
  return { record, replayed: false };
}

export async function decideBillableOpportunity(
  ctx: ServiceContext,
  input: DecideBillableOpportunityInput,
): Promise<DraftDecisionResult<BillableOpportunity>> {
  const data = parseInput(decideBillableOpportunityInput, input);
  const entity = { entityType: "billable_opportunity", entityId: data.id };
  const role = await ctx.authorize("billable.decide", entity);

  const locked = await ctx.tx.asService<Row>(
    `select * from public.billable_opportunities where id = $1 and organization_id = $2 for update`,
    [data.id, ctx.organizationId],
  );
  if (!locked.rows[0]) throw new NotFoundError("billable_opportunity", data.id);
  const current = toBillableOpportunity(locked.rows[0]);

  const authority = evaluateApprovalDecision(
    ctx.actor,
    role,
    BILLABLE_OPPORTUNITY_POLICY_SUBJECT,
    await loadApprovalDelegationRules(ctx),
  );
  if (!authority.allowed) {
    throw new ForbiddenError({
      action: "billable.decide",
      reason: authority.reason,
      organizationId: ctx.organizationId,
      ...entity,
    });
  }

  if (current.status !== "open") {
    if (current.status === data.decision) return { record: current, replayed: true };
    throw new ConflictError("already_decided", `billable opportunity is already ${current.status}`);
  }

  const updated = await ctx.tx.asService<Row>(
    `update public.billable_opportunities
        set status = $3, decided_by_user_id = $4, decided_at = now(), decision_note = $5,
            decision_policy_source = $6
      where id = $1 and organization_id = $2 and status = 'open'
      returning *`,
    [
      data.id,
      ctx.organizationId,
      data.decision,
      actorUserId(ctx.actor),
      data.note ?? null,
      authority.policySource,
    ],
  );
  const record = toBillableOpportunity(updated.rows[0] as Row);

  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.billableOpportunityDecided,
    entityType: "billable_opportunity",
    entityId: record.id,
    idempotencyKey: `billable_opportunity.decided:${record.id}`,
    payload: {
      decision: data.decision,
      policy_source: authority.policySource,
      job_id: record.jobId,
    },
  });
  await writeAudit(ctx, {
    action: `billable_opportunity.${data.decision}`,
    entityType: "billable_opportunity",
    entityId: record.id,
    sourceEventId: event.id,
    details: { decision: data.decision, decider_role: role, policy_source: authority.policySource },
  });
  return { record, replayed: false };
}
