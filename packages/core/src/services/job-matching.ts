// M3-T11: match an extracted job reference (e.g. "Wilson") to exactly one active job within the
// org, by job name or customer name. Field-capture facts name jobs the way a crew member would —
// a customer's last name, a site nickname — never a job id, so this is a best-effort text match,
// not a lookup. Zero or more-than-one candidate can't be resolved automatically, so — per
// CLAUDE.md rule 14 — it opens a clarification (ops case) instead of guessing which job a draft
// record belongs to.

import type { Job, OpsCase } from "@backoffice/domain";
import { toJob, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { createOpsCase } from "./ops";

export type JobMatchResult =
  | { status: "matched"; job: Job }
  | { status: "none"; opsCase: OpsCase }
  | { status: "ambiguous"; candidates: Job[]; opsCase: OpsCase };

const JOB_SELECT = `select j.*, c.display_name as customer_name
                      from public.jobs j
                      left join public.customers c on c.id = j.customer_id`;

function candidateEvidence(candidates: readonly Job[]) {
  return candidates.map((c) => ({ id: c.id, name: c.name, customerName: c.customerName }));
}

/** Case-insensitive substring match, either direction, so "Wilson" matches "Wilson Residence" and
 *  "Wilson Residence Regrade" matches a shorter reference too. */
function referenceMatches(reference: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const a = reference.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Resolve `jobRef` (raw text pulled from a crew message, e.g. "Wilson") to the one active job in
 * `ctx`'s organization whose name or customer name matches it. No match opens a `missing_data`
 * ops case; more than one match opens a `low_confidence` ops case listing every candidate, rather
 * than guessing which job a draft record should attach to.
 */
export async function resolveJobByReference(
  ctx: ServiceContext,
  jobRef: string,
): Promise<JobMatchResult> {
  await ctx.authorize("job.read");
  const reference = jobRef.trim();

  const { rows } = await ctx.scoped<Row>(
    `${JOB_SELECT} where j.organization_id = $1 and j.status = 'active'`,
    [ctx.organizationId],
  );
  const candidates = rows
    .map(toJob)
    .filter(
      (j) => referenceMatches(reference, j.name) || referenceMatches(reference, j.customerName),
    );

  const [only] = candidates;
  if (candidates.length === 0 || !only) {
    const opsCase = await createOpsCase(ctx, {
      title: `No active job matches "${jobRef}"`,
      reasonCode: "missing_data",
      priority: "normal",
      evidence: { job_ref: jobRef, candidates: [] },
    });
    return { status: "none", opsCase };
  }
  if (candidates.length === 1) return { status: "matched", job: only };

  const opsCase = await createOpsCase(ctx, {
    title: `Ambiguous job match for "${jobRef}"`,
    reasonCode: "low_confidence",
    priority: "normal",
    evidence: { job_ref: jobRef, candidates: candidateEvidence(candidates) },
  });
  return { status: "ambiguous", candidates, opsCase };
}
