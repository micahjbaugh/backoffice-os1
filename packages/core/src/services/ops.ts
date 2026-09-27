// Human backstop: ops cases, internal staff, and tenant-scoped operator grants.
//
// Internal operators are not tenant members. They reach a tenant's cases only through an explicit,
// reasoned, expiring, revocable grant created by that tenant's owner, and every case they open is
// audited as `internal_operator`.

import {
  actorUserId,
  ConflictError,
  createOpsCaseInput,
  decideOpsCaseInput,
  EVENT_TYPES,
  ForbiddenError,
  grantOperatorAccessInput,
  NotFoundError,
  parseInput,
  updateOpsCaseInput,
  type BusinessEvent,
  type CreateOpsCaseInput,
  type DecideOpsCaseInput,
  type GrantOperatorAccessInput,
  type InternalStaff,
  type OperatorGrant,
  type OpsCase,
  type UpdateOpsCaseInput,
  type UUID,
} from "@backoffice/domain";
import type { Tx } from "../db/tx";
import { toBusinessEvent, toOperatorGrant, toOpsCase, type Row } from "../rows";
import { inTenant, type ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

// ---------------------------------------------------------------------------
// Tenant side
// ---------------------------------------------------------------------------

export async function createOpsCase(
  ctx: ServiceContext,
  input: CreateOpsCaseInput,
): Promise<OpsCase> {
  await ctx.authorize("ops_case.create");
  const data = parseInput(createOpsCaseInput, input);
  await assertEntityInOrg(ctx, data.entityType, data.entityId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.ops_cases
       (organization_id, title, reason_code, priority, entity_type, entity_id, evidence, sla_due_at, created_by_actor_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [
      ctx.organizationId,
      data.title,
      data.reasonCode,
      data.priority,
      data.entityType ?? null,
      data.entityId ?? null,
      data.evidence,
      data.slaDueAt ?? null,
      ctx.actor.type,
    ],
  );
  const opsCase = toOpsCase(rows[0] as Row);
  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.opsCaseCreated,
    entityType: "ops_case",
    entityId: opsCase.id,
    payload: { reason_code: opsCase.reasonCode, priority: opsCase.priority },
  });
  await writeAudit(ctx, {
    action: "ops_case.created",
    entityType: "ops_case",
    entityId: opsCase.id,
    sourceEventId: event.id,
    details: { reason_code: opsCase.reasonCode, priority: opsCase.priority },
  });
  return opsCase;
}

export async function listOrgOpsCases(ctx: ServiceContext): Promise<OpsCase[]> {
  await ctx.authorize("ops_case.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.ops_cases where organization_id = $1 order by created_at desc`,
    [ctx.organizationId],
  );
  return rows.map(toOpsCase);
}

export interface OpsCaseDecisionResult {
  opsCase: OpsCase;
  /** True when this call repeated an already-applied identical decision; nothing was written. */
  replayed: boolean;
}

/**
 * Owner/office admin/manager resolving or dismissing an open clarification from their own inbox.
 * Distinct from `updateOpsCaseAsOperator`: this is the tenant side, and clients have no UPDATE
 * privilege on `ops_cases` at all (0002_m1_foundation.sql revokes it), so this is the only way to
 * change a case's status from that side. A repeated identical decision is a no-op replay; a
 * conflicting one is a ConflictError.
 */
export async function decideOpsCase(
  ctx: ServiceContext,
  input: DecideOpsCaseInput,
): Promise<OpsCaseDecisionResult> {
  const data = parseInput(decideOpsCaseInput, input);
  const entity = { entityType: "ops_case", entityId: data.id };
  await ctx.authorize("ops_case.resolve", entity);
  const decider = actorUserId(ctx.actor);
  if (ctx.actor.type !== "user" || !decider) {
    throw new ForbiddenError({
      action: "ops_case.resolve",
      reason: "only_human_members_decide",
      organizationId: ctx.organizationId,
      ...entity,
    });
  }

  const locked = await ctx.tx.asService<Row>(
    `select * from public.ops_cases where id = $1 and organization_id = $2 for update`,
    [data.id, ctx.organizationId],
  );
  if (!locked.rows[0]) throw new NotFoundError("ops_case", data.id);
  const current = toOpsCase(locked.rows[0]);
  const status = data.decision === "resolved" ? "resolved" : "closed";

  if (current.status === "resolved" || current.status === "closed") {
    if (current.status === status) return { opsCase: current, replayed: true };
    throw new ConflictError("already_decided", `ops case is already ${current.status}`);
  }

  const { rows } = await ctx.tx.asService<Row>(
    `update public.ops_cases
        set status = $3::public.ops_case_status, resolution = coalesce($4, resolution)
      where id = $1 and organization_id = $2
      returning *`,
    [data.id, ctx.organizationId, status, data.note ?? null],
  );
  const opsCase = toOpsCase(rows[0] as Row);

  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.opsCaseUpdated,
    entityType: "ops_case",
    entityId: opsCase.id,
    idempotencyKey: `ops_case.decided:${opsCase.id}`,
    payload: { decision: data.decision, previous_status: current.status },
  });
  await writeAudit(ctx, {
    action: `ops_case.${data.decision}`,
    entityType: "ops_case",
    entityId: opsCase.id,
    sourceEventId: event.id,
    details: {
      decision: data.decision,
      previous_status: current.status,
      decider_role: await ctx.role(),
    },
  });
  return { opsCase, replayed: false };
}

export async function grantOperatorAccess(
  ctx: ServiceContext,
  input: GrantOperatorAccessInput,
): Promise<OperatorGrant> {
  await ctx.authorize("operator_grant.manage");
  const data = parseInput(grantOperatorAccessInput, input);
  const operator = await ctx.tx.asService<{ id: UUID }>(
    `select u.id from auth.users u
       join public.internal_staff s on s.user_id = u.id and s.active
      where lower(u.email) = $1`,
    [data.operatorEmail],
  );
  const operatorUserId = operator.rows[0]?.id;
  if (!operatorUserId) throw new NotFoundError("internal operator with that email");

  const grantor = actorUserId(ctx.actor);
  const superseded = await ctx.tx.asService<{ id: UUID }>(
    `update public.internal_operator_grants
        set revoked_at = now(), revoked_by_user_id = $3
      where organization_id = $1 and operator_user_id = $2 and revoked_at is null
      returning id`,
    [ctx.organizationId, operatorUserId, grantor],
  );
  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.internal_operator_grants
       (organization_id, operator_user_id, granted_by_user_id, reason, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(hours => $5))
     returning *`,
    [ctx.organizationId, operatorUserId, grantor, data.reason, data.durationHours],
  );
  const grant = toOperatorGrant({
    ...(rows[0] as Row),
    operator_email: data.operatorEmail,
    active: true,
  });
  await writeAudit(ctx, {
    action: "operator_grant.created",
    entityType: "operator_grant",
    entityId: grant.id,
    details: {
      operator_user_id: operatorUserId,
      reason: data.reason,
      expires_at: grant.expiresAt,
      superseded_grant_ids: superseded.rows.map((r) => r.id),
    },
  });
  return grant;
}

export async function revokeOperatorAccess(ctx: ServiceContext, grantId: UUID): Promise<void> {
  await ctx.authorize("operator_grant.manage", { entityType: "operator_grant", entityId: grantId });
  const { rows } = await ctx.tx.asService<Row>(
    `update public.internal_operator_grants
        set revoked_at = now(), revoked_by_user_id = $3
      where id = $1 and organization_id = $2 and revoked_at is null
      returning *`,
    [grantId, ctx.organizationId, actorUserId(ctx.actor)],
  );
  if (!rows[0]) throw new NotFoundError("active operator grant", grantId);
  await writeAudit(ctx, {
    action: "operator_grant.revoked",
    entityType: "operator_grant",
    entityId: grantId,
    details: { operator_user_id: rows[0].operator_user_id },
  });
}

export async function listOperatorGrants(ctx: ServiceContext): Promise<OperatorGrant[]> {
  await ctx.authorize("operator_grant.manage");
  const { rows } = await ctx.tx.asService<Row>(
    `select g.*, u.email as operator_email,
            (g.revoked_at is null and g.expires_at > now()) as active
       from public.internal_operator_grants g
       left join auth.users u on u.id = g.operator_user_id
      where g.organization_id = $1
      order by g.created_at desc`,
    [ctx.organizationId],
  );
  return rows.map(toOperatorGrant);
}

// ---------------------------------------------------------------------------
// Internal operator side (tx.actor must be an internal_operator)
// ---------------------------------------------------------------------------

export async function getInternalStaff(tx: Tx, userId: UUID): Promise<InternalStaff | null> {
  const { rows } = await tx.asService<Row>(
    `select user_id, role, active from public.internal_staff where user_id = $1 and active`,
    [userId],
  );
  const row = rows[0];
  return row
    ? { userId: row.user_id as UUID, role: row.role as InternalStaff["role"], active: true }
    : null;
}

export async function requireInternalStaff(tx: Tx): Promise<InternalStaff> {
  if (tx.actor.type !== "internal_operator") {
    throw new ForbiddenError({ action: "ops.access", reason: `actor:${tx.actor.type}` });
  }
  const staff = await getInternalStaff(tx, tx.actor.userId);
  if (!staff) throw new ForbiddenError({ action: "ops.access", reason: "not_internal_staff" });
  return staff;
}

const OPS_CASE_SELECT = `select c.*, o.name as organization_name
                           from public.ops_cases c
                           join public.organizations o on o.id = c.organization_id`;

/**
 * Cases across every tenant the operator currently holds a live grant for.
 * Read through RLS, and explicitly grant-filtered so tenant membership never substitutes for a grant.
 */
export async function listOperatorCases(
  tx: Tx,
  options: { includeClosed?: boolean } = {},
): Promise<OpsCase[]> {
  await requireInternalStaff(tx);
  const { rows } = await tx.asUser<Row>(
    `${OPS_CASE_SELECT}
      where public.has_operator_grant(c.organization_id)
        and ($1 or c.status not in ('resolved', 'closed'))
      order by case c.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
               c.sla_due_at nulls last, c.created_at`,
    [options.includeClosed ?? false],
  );
  return rows.map(toOpsCase);
}

async function loadGrantedCase(tx: Tx, caseId: UUID, action: string): Promise<OpsCase> {
  const { rows } = await tx.asUser<Row>(
    `${OPS_CASE_SELECT} where c.id = $1 and public.has_operator_grant(c.organization_id)`,
    [caseId],
  );
  if (rows[0]) return toOpsCase(rows[0]);

  const exists = await tx.asService<{ organization_id: UUID }>(
    `select organization_id from public.ops_cases where id = $1`,
    [caseId],
  );
  const orgId = exists.rows[0]?.organization_id;
  if (!orgId) throw new NotFoundError("ops case", caseId);
  throw new ForbiddenError({
    action,
    reason: "no_active_grant",
    organizationId: orgId,
    entityType: "ops_case",
    entityId: caseId,
  });
}

export interface OpsCaseDetail {
  opsCase: OpsCase;
  timeline: BusinessEvent[];
}

/** Open a tenant case. Requires internal staff + live grant; the access itself is audited. */
export async function openOpsCase(tx: Tx, caseId: UUID): Promise<OpsCaseDetail> {
  await requireInternalStaff(tx);
  const opsCase = await loadGrantedCase(tx, caseId, "ops_case.open");
  const ctx = inTenant(tx, opsCase.organizationId);
  await writeAudit(ctx, {
    action: "ops_case.viewed",
    entityType: "ops_case",
    entityId: opsCase.id,
    details: { reason_code: opsCase.reasonCode },
  });
  const { rows } = await tx.asService<Row>(
    `select * from public.business_events
      where organization_id = $1 and entity_type = 'ops_case' and entity_id = $2
      order by occurred_at`,
    [opsCase.organizationId, opsCase.id],
  );
  return { opsCase, timeline: rows.map(toBusinessEvent) };
}

export async function updateOpsCaseAsOperator(
  tx: Tx,
  caseId: UUID,
  input: UpdateOpsCaseInput,
): Promise<OpsCase> {
  await requireInternalStaff(tx);
  const data = parseInput(updateOpsCaseInput, input);
  const before = await loadGrantedCase(tx, caseId, "ops_case.update");
  const ctx = inTenant(tx, before.organizationId);
  const operatorId = actorUserId(tx.actor);

  const status =
    data.status ?? (data.assignToSelf && before.status === "new" ? "assigned" : before.status);
  const { rows } = await tx.asService<Row>(
    `update public.ops_cases
        set status = $3::public.ops_case_status,
            resolution = coalesce($4, resolution),
            automation_gap_category = coalesce($5, automation_gap_category),
            assigned_operator_user_id = case when $6 then $7::uuid else assigned_operator_user_id end
      where id = $1 and organization_id = $2
      returning *`,
    [
      caseId,
      before.organizationId,
      status,
      data.resolution ?? null,
      data.automationGapCategory ?? null,
      data.assignToSelf ?? false,
      operatorId,
    ],
  );
  const opsCase = toOpsCase({ ...(rows[0] as Row), organization_name: before.organizationName });
  const changes = {
    status: { from: before.status, to: opsCase.status },
    assigned_to_self: data.assignToSelf ?? false,
    resolution_set: data.resolution !== undefined,
    automation_gap_category: data.automationGapCategory ?? null,
  };
  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.opsCaseUpdated,
    entityType: "ops_case",
    entityId: opsCase.id,
    payload: changes,
  });
  await writeAudit(ctx, {
    action: "ops_case.updated",
    entityType: "ops_case",
    entityId: opsCase.id,
    sourceEventId: event.id,
    details: changes,
  });
  return opsCase;
}
