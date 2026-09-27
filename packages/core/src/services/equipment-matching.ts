// M3-T12: match an extracted equipment reference (e.g. "Hoe", "D6") to exactly one active piece
// of equipment within the org, by name or alias. Field-capture facts name equipment the way a
// crew member would — a nickname or shorthand, never an equipment id — so this is a best-effort
// text match, not a lookup. Zero or more-than-one candidate can't be resolved automatically, so —
// per CLAUDE.md rule 14 — it opens a clarification (ops case) instead of guessing which piece of
// equipment a draft usage record belongs to. Mirrors ./job-matching.ts.

import type { Equipment, OpsCase } from "@backoffice/domain";
import { toEquipment, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { createOpsCase } from "./ops";

export type EquipmentMatchResult =
  | { status: "matched"; equipment: Equipment }
  | { status: "none"; opsCase: OpsCase }
  | { status: "ambiguous"; candidates: Equipment[]; opsCase: OpsCase };

function candidateEvidence(candidates: readonly Equipment[]) {
  return candidates.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
}

/** Case-insensitive substring match, either direction, so "Hoe" matches "Backhoe" and a longer
 *  name or alias still matches a shorter reference. */
function referenceMatches(reference: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const a = reference.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function equipmentMatches(reference: string, equipment: Equipment): boolean {
  return (
    referenceMatches(reference, equipment.name) ||
    equipment.aliases.some((alias) => referenceMatches(reference, alias))
  );
}

/**
 * Resolve `equipmentRef` (raw text pulled from a crew message, e.g. "D6") to the one active
 * equipment record in `ctx`'s organization whose name or an alias matches it. No match opens a
 * `missing_data` ops case; more than one match opens a `low_confidence` ops case listing every
 * candidate, rather than guessing which equipment a draft usage record should attach to.
 */
export async function resolveEquipmentByReference(
  ctx: ServiceContext,
  equipmentRef: string,
): Promise<EquipmentMatchResult> {
  await ctx.authorize("equipment.read");
  const reference = equipmentRef.trim();

  const { rows } = await ctx.scoped<Row>(
    `select * from public.equipment where organization_id = $1 and active = true`,
    [ctx.organizationId],
  );
  const candidates = rows.map(toEquipment).filter((e) => equipmentMatches(reference, e));

  const [only] = candidates;
  if (candidates.length === 0 || !only) {
    const opsCase = await createOpsCase(ctx, {
      title: `No active equipment matches "${equipmentRef}"`,
      reasonCode: "missing_data",
      priority: "normal",
      evidence: { equipment_ref: equipmentRef, candidates: [] },
    });
    return { status: "none", opsCase };
  }
  if (candidates.length === 1) return { status: "matched", equipment: only };

  const opsCase = await createOpsCase(ctx, {
    title: `Ambiguous equipment match for "${equipmentRef}"`,
    reasonCode: "low_confidence",
    priority: "normal",
    evidence: { equipment_ref: equipmentRef, candidates: candidateEvidence(candidates) },
  });
  return { status: "ambiguous", candidates, opsCase };
}
