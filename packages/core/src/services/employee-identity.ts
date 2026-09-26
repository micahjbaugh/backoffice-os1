// M3-T01: resolve an inbound phone number (a field employee's SMS/call) to exactly one active
// employee within the org. Field-capture attribution must know who sent a report, so — unlike
// matchCallerByPhone (M2-T08), which silently misses on zero candidates — an unrecognized or
// ambiguous number here opens an ops case rather than dropping the message (CLAUDE.md rule 14:
// never silently guess ambiguous business data).

import { normalizeToE164, type Employee, type OpsCase } from "@backoffice/domain";
import { toEmployee, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { createOpsCase } from "./ops";

export type EmployeePhoneLookupResult =
  | { status: "matched"; employee: Employee }
  | { status: "unknown"; opsCase: OpsCase }
  | { status: "ambiguous"; candidates: Employee[]; opsCase: OpsCase };

function candidateEvidence(candidates: readonly Employee[]) {
  return candidates.map((c) => ({ id: c.id, displayName: c.displayName }));
}

/**
 * Look up the active employee whose phone matches `rawPhone` in `ctx`'s organization.
 * Zero or unparseable-number matches open a `missing_data` ops case; more than one active
 * employee sharing a number opens a `low_confidence` ops case (evidence lists every candidate)
 * instead of guessing which employee sent the message.
 */
export async function resolveEmployeeByPhone(
  ctx: ServiceContext,
  rawPhone: string,
): Promise<EmployeePhoneLookupResult> {
  await ctx.authorize("employee.read");
  const parsed = normalizeToE164(rawPhone);

  if (!parsed) {
    const opsCase = await createOpsCase(ctx, {
      title: `Unrecognized phone number ${rawPhone}`,
      reasonCode: "missing_data",
      priority: "normal",
      evidence: { phone: rawPhone, normalized_phone: null, candidates: [] },
    });
    return { status: "unknown", opsCase };
  }

  const { rows } = await ctx.scoped<Row>(
    `select * from public.employees where organization_id = $1 and active and phone is not null`,
    [ctx.organizationId],
  );
  const candidates = rows
    .filter((r) => normalizeToE164(r.phone as string)?.e164 === parsed.e164)
    .map(toEmployee);

  const [only] = candidates;
  if (candidates.length === 0 || !only) {
    const opsCase = await createOpsCase(ctx, {
      title: `No active employee matches ${rawPhone}`,
      reasonCode: "missing_data",
      priority: "normal",
      evidence: { phone: rawPhone, normalized_phone: parsed.e164, candidates: [] },
    });
    return { status: "unknown", opsCase };
  }
  if (candidates.length === 1) return { status: "matched", employee: only };

  const opsCase = await createOpsCase(ctx, {
    title: `Ambiguous employee match for ${rawPhone}`,
    reasonCode: "low_confidence",
    priority: "normal",
    evidence: {
      phone: rawPhone,
      normalized_phone: parsed.e164,
      candidates: candidateEvidence(candidates),
    },
  });
  return { status: "ambiguous", candidates, opsCase };
}
