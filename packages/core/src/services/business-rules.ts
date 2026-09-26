// Business rules are versioned data (ARCHITECTURE §6). M1 supports `approval.decide`
// delegation rules; the evaluator lives in @backoffice/domain.

import {
  actorUserId,
  APPROVAL_DECIDE_RULE_ACTION,
  approvalDelegationDefinitionSchema,
  createApprovalRuleInput,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  type ApprovalDelegationRule,
  type BusinessRule,
  type CreateApprovalRuleInput,
  type UUID,
} from "@backoffice/domain";
import { toBusinessRule, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { recordEvent } from "./events";

export async function listRules(ctx: ServiceContext): Promise<BusinessRule[]> {
  await ctx.authorize("rule.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.business_rules
      where organization_id = $1
      order by action, rule_key, version desc`,
    [ctx.organizationId],
  );
  return rows.map(toBusinessRule);
}

/**
 * Active delegation rules for approval decisions. Invalid definitions are ignored, so a malformed
 * rule can only ever *remove* authority (fail closed), never grant it.
 */
export async function loadApprovalDelegationRules(
  ctx: ServiceContext,
): Promise<ApprovalDelegationRule[]> {
  const { rows } = await ctx.tx.asService<Row>(
    `select * from public.business_rules
      where organization_id = $1
        and action = $2
        and enabled
        and effective_from <= now()
        and (effective_to is null or effective_to > now())`,
    [ctx.organizationId, APPROVAL_DECIDE_RULE_ACTION],
  );
  const rules: ApprovalDelegationRule[] = [];
  for (const rule of rows.map(toBusinessRule)) {
    const parsed = approvalDelegationDefinitionSchema.safeParse(rule.definition);
    if (parsed.success) rules.push({ id: rule.id, version: rule.version, definition: parsed.data });
    else console.warn(`ignoring invalid business rule ${rule.id}`);
  }
  return rules;
}

/** Create the next version of an approval-delegation rule, retiring the previous active version. */
export async function createApprovalRuleVersion(
  ctx: ServiceContext,
  input: CreateApprovalRuleInput,
): Promise<BusinessRule> {
  await ctx.authorize("rule.write");
  const data = parseInput(createApprovalRuleInput, input);
  const definition = parseInput(approvalDelegationDefinitionSchema, {
    roles: data.roles,
    ...(data.approvalTypes ? { approval_types: data.approvalTypes } : {}),
    ...(data.maxAmountCents !== undefined ? { max_amount_cents: data.maxAmountCents } : {}),
  });

  const previous = await ctx.tx.asService<Row>(
    `select * from public.business_rules
      where organization_id = $1 and action = $2 and rule_key = $3
      order by version desc
      for update`,
    [ctx.organizationId, APPROVAL_DECIDE_RULE_ACTION, data.ruleKey],
  );
  const latest = previous.rows[0] ? toBusinessRule(previous.rows[0]) : null;
  await ctx.tx.asService(
    `update public.business_rules set effective_to = now()
      where organization_id = $1 and action = $2 and rule_key = $3 and effective_to is null`,
    [ctx.organizationId, APPROVAL_DECIDE_RULE_ACTION, data.ruleKey],
  );
  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.business_rules
       (organization_id, action, rule_key, version, enabled, definition, created_by_user_id)
     values ($1, $2, $3, $4, true, $5, $6)
     returning *`,
    [
      ctx.organizationId,
      APPROVAL_DECIDE_RULE_ACTION,
      data.ruleKey,
      (latest?.version ?? 0) + 1,
      definition,
      actorUserId(ctx.actor),
    ],
  );
  const rule = toBusinessRule(rows[0] as Row);
  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.ruleVersionCreated,
    entityType: "business_rule",
    entityId: rule.id,
    payload: { action: rule.action, rule_key: rule.ruleKey, version: rule.version, definition },
  });
  await writeAudit(ctx, {
    action: "business_rule.version_created",
    entityType: "business_rule",
    entityId: rule.id,
    sourceEventId: event.id,
    details: {
      rule_key: rule.ruleKey,
      version: rule.version,
      previous_rule_id: latest?.id ?? null,
      definition,
    },
  });
  return rule;
}

export async function retireRule(ctx: ServiceContext, ruleId: UUID): Promise<void> {
  await ctx.authorize("rule.write", { entityType: "business_rule", entityId: ruleId });
  const { rows } = await ctx.tx.asService<Row>(
    `update public.business_rules set effective_to = now()
      where id = $1 and organization_id = $2 and effective_to is null
      returning *`,
    [ruleId, ctx.organizationId],
  );
  if (!rows[0]) throw new NotFoundError("active business rule", ruleId);
  const rule = toBusinessRule(rows[0]);
  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.ruleRetired,
    entityType: "business_rule",
    entityId: rule.id,
    payload: { rule_key: rule.ruleKey, version: rule.version },
  });
  await writeAudit(ctx, {
    action: "business_rule.retired",
    entityType: "business_rule",
    entityId: rule.id,
    sourceEventId: event.id,
    details: { rule_key: rule.ruleKey, version: rule.version },
  });
}
