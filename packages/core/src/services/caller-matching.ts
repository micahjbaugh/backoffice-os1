// M2-T08: match an inbound/outbound call or SMS counterparty to a customer or employee by phone,
// scoped to one organization. Feeds communication-record creation (M2-T09); never guesses which
// entity a call belongs to when more than one candidate matches (CLAUDE.md rule 14).

import { normalizePhoneNumber, type OpsCase, type UUID } from "@backoffice/domain";
import type { Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { createOpsCase } from "./ops";

export type CallerMatchEntityType = "customer" | "employee";

export interface CallerMatchCandidate {
  entityType: CallerMatchEntityType;
  entityId: UUID;
  displayName: string;
}

export type CallerMatchResult =
  | { status: "no_match" }
  | ({ status: "matched" } & CallerMatchCandidate)
  | { status: "ambiguous"; candidates: CallerMatchCandidate[]; opsCase: OpsCase };

function str(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`expected string, got ${typeof value}`);
  return value;
}

async function candidatesFor(
  ctx: ServiceContext,
  table: "customers" | "employees",
  entityType: CallerMatchEntityType,
  normalized: string,
): Promise<CallerMatchCandidate[]> {
  const { rows } = await ctx.scoped<Row>(
    `select id, display_name, phone from public.${table} where organization_id = $1 and phone is not null`,
    [ctx.organizationId],
  );
  return rows
    .filter((r) => normalizePhoneNumber(str(r.phone)) === normalized)
    .map((r) => ({ entityType, entityId: str(r.id), displayName: str(r.display_name) }));
}

/**
 * Look up the customer/employee whose phone matches `rawPhone` in the caller's organization.
 * Zero candidates is a plain miss; more than one can't be resolved automatically, so it opens a
 * `low_confidence` ops case (evidence lists every candidate) instead of picking one.
 */
export async function matchCallerByPhone(
  ctx: ServiceContext,
  rawPhone: string,
): Promise<CallerMatchResult> {
  const normalized = normalizePhoneNumber(rawPhone);
  if (!normalized) return { status: "no_match" };

  await ctx.authorize("customer.read");
  await ctx.authorize("employee.read");

  const candidates = [
    ...(await candidatesFor(ctx, "customers", "customer", normalized)),
    ...(await candidatesFor(ctx, "employees", "employee", normalized)),
  ];

  const [only] = candidates;
  if (candidates.length === 0 || !only) return { status: "no_match" };
  if (candidates.length === 1) return { status: "matched", ...only };

  const opsCase = await createOpsCase(ctx, {
    title: `Ambiguous caller match for ${rawPhone}`,
    reasonCode: "low_confidence",
    priority: "normal",
    evidence: { phone: rawPhone, normalized_phone: normalized, candidates },
  });
  return { status: "ambiguous", candidates, opsCase };
}
