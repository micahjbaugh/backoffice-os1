// M2-T19: resolve the tenant and receptionist configuration for a synchronous Vapi assistant-request.
//
// A number with no `provider_routes` entry has no tenant to escalate to, exactly like other
// unroutable webhooks (see ./webhooks.ts). A number that resolves to a tenant with no active
// `receptionist.config` business rule gets a fallback answer *and* an ops case, since only the
// owner can fix a missing configuration (CLAUDE.md rule 14: never guess business hours).

import {
  RECEPTIONIST_CONFIG_RULE_ACTION,
  receptionistConfigDefinitionSchema,
  type BusinessInfoTopic,
  type ReceptionistConfigDefinition,
  type UUID,
} from "@backoffice/domain";
import { toBusinessRule, toOrganization, type Row } from "../rows";
import { inTenant, type ServiceContext } from "../runtime";
import type { Tx } from "../db/tx";
import { createOpsCase } from "./ops";
import { resolveProviderRoute } from "./webhooks";

export type ReceptionistResolution =
  | { status: "unknown_number" }
  | { status: "missing_config"; organizationId: UUID }
  | { status: "resolved"; organizationId: UUID; businessName: string; businessHours: string };

/** The active `receptionist.config` business rule, parsed, or null if none is active/valid. */
async function loadActiveReceptionistConfig(
  ctx: ServiceContext,
): Promise<ReceptionistConfigDefinition | null> {
  const { rows } = await ctx.scoped<Row>(
    `select * from public.business_rules
      where organization_id = $1 and action = $2 and enabled
        and effective_from <= now() and (effective_to is null or effective_to > now())
      order by version desc
      limit 1`,
    [ctx.organizationId, RECEPTIONIST_CONFIG_RULE_ACTION],
  );
  const rule = rows[0] ? toBusinessRule(rows[0]) : null;
  const parsed = rule ? receptionistConfigDefinitionSchema.safeParse(rule.definition) : null;
  return parsed?.success ? parsed.data : null;
}

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
  const config = await loadActiveReceptionistConfig(ctx);

  if (!org || !config) {
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
    businessHours: config.business_hours,
  };
}

const BUSINESS_INFO_FIELD: Record<BusinessInfoTopic, keyof ReceptionistConfigDefinition> = {
  hours: "business_hours",
  services: "services",
  service_area: "service_area",
  address: "address",
};

/**
 * Agent-callable: the receptionist's `lookup_business_info` tool (MASTER_SPEC §8 GREEN action).
 * Reads only the one whitelisted field of the tenant's active `receptionist.config` rule for the
 * requested topic — never any other business rule or record — so a caller can never be told
 * anything the owner hasn't explicitly configured for disclosure (ARCHITECTURE.md §13).
 */
export async function lookupBusinessInfo(
  ctx: ServiceContext,
  topic: BusinessInfoTopic,
): Promise<string | null> {
  await ctx.authorize("receptionist.lookup");
  const config = await loadActiveReceptionistConfig(ctx);
  return config?.[BUSINESS_INFO_FIELD[topic]] ?? null;
}
