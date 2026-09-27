// M3-T13: match an extracted employee reference (e.g. "Jake Tyler") to exactly one active
// employee within the org, by display name. Field-capture facts name crew the way a coworker
// would — a first name, a full name — never an employee id, so this is a best-effort text match,
// not a lookup. Zero or more-than-one candidate can't be resolved automatically, so — per
// CLAUDE.md rule 14 — it opens a clarification (ops case) instead of guessing which employee a
// draft time entry belongs to. Mirrors ./job-matching.ts and ./equipment-matching.ts.

import type { Employee, OpsCase } from "@backoffice/domain";
import { toEmployee, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { createOpsCase } from "./ops";

export type EmployeeMatchResult =
  | { status: "matched"; employee: Employee }
  | { status: "none"; opsCase: OpsCase }
  | { status: "ambiguous"; candidates: Employee[]; opsCase: OpsCase };

function candidateEvidence(candidates: readonly Employee[]) {
  return candidates.map((c) => ({ id: c.id, displayName: c.displayName }));
}

/** Case-insensitive substring match, either direction, so "Jake" matches "Jake Tyler" and a full
 *  name still matches an exact reference. */
function referenceMatches(reference: string, candidate: string): boolean {
  const a = reference.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Resolve `employeeRef` (raw text pulled from a crew message, e.g. "Jake Tyler") to the one
 * active employee in `ctx`'s organization whose display name matches it. No match opens a
 * `missing_data` ops case; more than one match opens a `low_confidence` ops case listing every
 * candidate, rather than guessing which employee a draft time entry should attach to.
 */
export async function resolveEmployeeByReference(
  ctx: ServiceContext,
  employeeRef: string,
): Promise<EmployeeMatchResult> {
  await ctx.authorize("employee.read");
  const reference = employeeRef.trim();

  const { rows } = await ctx.scoped<Row>(
    `select * from public.employees where organization_id = $1 and active = true`,
    [ctx.organizationId],
  );
  const candidates = rows.map(toEmployee).filter((e) => referenceMatches(reference, e.displayName));

  const [only] = candidates;
  if (candidates.length === 0 || !only) {
    const opsCase = await createOpsCase(ctx, {
      title: `No active employee matches "${employeeRef}"`,
      reasonCode: "missing_data",
      priority: "normal",
      evidence: { employee_ref: employeeRef, candidates: [] },
    });
    return { status: "none", opsCase };
  }
  if (candidates.length === 1) return { status: "matched", employee: only };

  const opsCase = await createOpsCase(ctx, {
    title: `Ambiguous employee match for "${employeeRef}"`,
    reasonCode: "low_confidence",
    priority: "normal",
    evidence: { employee_ref: employeeRef, candidates: candidateEvidence(candidates) },
  });
  return { status: "ambiguous", candidates, opsCase };
}
