// M2-T19: resolve the tenant and receptionist configuration for a synchronous Vapi assistant-request.
//
// A number with no `provider_routes` entry has no tenant to escalate to, exactly like other
// unroutable webhooks (see ./webhooks.ts). A number that resolves to a tenant with no active
// `receptionist.config` business rule gets a fallback answer *and* an ops case, since only the
// owner can fix a missing configuration (CLAUDE.md rule 14: never guess business hours).

import {
  RECEPTIONIST_CONFIG_RULE_ACTION,
  receptionistConfigDefinitionSchema,
  type UUID,
} from "@backoffice/domain";
import { toBusinessRule, toOrganization, type Row } from "../rows";
import { inTenant } from "../runtime";
import type { Tx } from "../db/tx";
import { createOpsCase } from "./ops";
import { resolveProviderRoute } from "./webhooks";

export type ReceptionistResolution =
  | { status: "unknown_number" }
  | { status: "missing_config"; organizationId: UUID }
  | { status: "resolved"; organizationId: UUID; businessName: string; businessHours: string };

export async function resolveReceptionistConfig(
  tx: Tx,
  params: { provider: string; routingAddress: string | null },
): Promise<ReceptionistResolution> {
  const organizationId = await resolveProviderRoute(tx, params.provider, params.routingAddress);
  if (!organizationId) return { status: "unknown_number" };

  const ctx = inTenant(tx, organizationId);
  await ctx.authorize("org.read");
  const { rows: orgRows } = await ctx.scoped<Row>(
    `select * from public.organizations where id = $1`,
    [organizationId],
  );
  const org = orgRows[0] ? toOrganization(orgRows[0]) : null;

  await ctx.authorize("rule.read");
  const { rows: ruleRows } = await ctx.scoped<Row>(
    `select * from public.business_rules
      where organization_id = $1 and action = $2 and enabled
        and effective_from <= now() and (effective_to is null or effective_to > now())
      order by version desc
      limit 1`,
    [organizationId, RECEPTIONIST_CONFIG_RULE_ACTION],
  );
  const rule = ruleRows[0] ? toBusinessRule(ruleRows[0]) : null;
  const parsed = rule ? receptionistConfigDefinitionSchema.safeParse(rule.definition) : null;

  if (!org || !parsed?.success) {
    await createOpsCase(ctx, {
      title: `Receptionist has no active configuration for ${params.routingAddress ?? "this number"}`,
      reasonCode: "missing_data",
      priority: "high",
      evidence: { provider: params.provider, routing_address: params.routingAddress },
    });
    return { status: "missing_config", organizationId };
  }

  return {
    status: "resolved",
    organizationId,
    businessName: org.name,
    businessHours: parsed.data.business_hours,
  };
}
