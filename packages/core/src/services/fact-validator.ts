// M3-T13: fact validator (ARCHITECTURE.md §4 step 5). Runs after extraction and before any draft
// is written: known employee/job/equipment (M3-T11/T12/T13 matching), plausible times ("7-5:30" =
// 10.5h), and duplicate facts within one extraction. A fact that fails any check never becomes a
// guess (CLAUDE.md rule 14) — it opens a clarification ops case instead and stays out of the draft
// path entirely; the field capture workflow (M3-T14) decides what to draft only from a "valid"
// result. Confidence-below-threshold facts also stop here, before ever reaching a draft table.

import {
  computeShiftHours,
  isDuplicateFact,
  isPlausibleHours,
  meetsConfidenceThreshold,
  type Employee,
  type Equipment,
  type FieldCaptureFact,
  type Job,
  type OpsCase,
} from "@backoffice/domain";
import { resolveEmployeeByReference } from "./employee-matching";
import { resolveEquipmentByReference } from "./equipment-matching";
import { resolveJobByReference } from "./job-matching";
import { createOpsCase } from "./ops";
import type { ServiceContext } from "../runtime";

export interface ResolvedFactEntities {
  employee?: Employee;
  job?: Job;
  equipment?: Equipment;
}

export type FactClarificationReason =
  | "low_confidence"
  | "unmatched_employee"
  | "unmatched_job"
  | "unmatched_equipment"
  | "implausible_time";

export type FactValidationResult =
  | { status: "valid"; fact: FieldCaptureFact; entities: ResolvedFactEntities; hours?: number }
  | {
      status: "needs_clarification";
      fact: FieldCaptureFact;
      reason: FactClarificationReason;
      opsCase: OpsCase;
    }
  | { status: "duplicate"; fact: FieldCaptureFact };

async function lowConfidenceCase(ctx: ServiceContext, fact: FieldCaptureFact): Promise<OpsCase> {
  return createOpsCase(ctx, {
    title: `Low-confidence ${fact.type} fact "${fact.factKey}"`,
    reasonCode: "low_confidence",
    priority: "normal",
    evidence: { fact_key: fact.factKey, fact_type: fact.type, confidence: fact.confidence },
  });
}

async function implausibleTimeCase(ctx: ServiceContext, fact: FieldCaptureFact): Promise<OpsCase> {
  return createOpsCase(ctx, {
    title: `Implausible time for "${fact.factKey}"`,
    reasonCode: "low_confidence",
    priority: "normal",
    evidence: { fact_key: fact.factKey, fact_type: fact.type, fields: fact.fields },
  });
}

/**
 * Validate one extracted fact against the org's known employees/jobs/equipment and against the
 * other facts already seen in this extraction (`priorFacts`, for duplicate detection). Never
 * writes a draft record itself — callers act on the `"valid"` result to create one.
 */
export async function validateFieldCaptureFact(
  ctx: ServiceContext,
  fact: FieldCaptureFact,
  priorFacts: readonly FieldCaptureFact[],
): Promise<FactValidationResult> {
  if (isDuplicateFact(fact, priorFacts)) return { status: "duplicate", fact };

  if (!meetsConfidenceThreshold(fact.confidence)) {
    return {
      status: "needs_clarification",
      fact,
      reason: "low_confidence",
      opsCase: await lowConfidenceCase(ctx, fact),
    };
  }

  const entities: ResolvedFactEntities = {};

  if (fact.type === "time_entry") {
    const match = await resolveEmployeeByReference(ctx, fact.fields.employeeRef);
    if (match.status !== "matched") {
      return {
        status: "needs_clarification",
        fact,
        reason: "unmatched_employee",
        opsCase: match.opsCase,
      };
    }
    entities.employee = match.employee;
  } else if (fact.type === "equipment_usage") {
    const match = await resolveEquipmentByReference(ctx, fact.fields.equipmentRef);
    if (match.status !== "matched") {
      return {
        status: "needs_clarification",
        fact,
        reason: "unmatched_equipment",
        opsCase: match.opsCase,
      };
    }
    entities.equipment = match.equipment;
  }

  if (fact.fields.jobRef) {
    const match = await resolveJobByReference(ctx, fact.fields.jobRef);
    if (match.status !== "matched") {
      return {
        status: "needs_clarification",
        fact,
        reason: "unmatched_job",
        opsCase: match.opsCase,
      };
    }
    entities.job = match.job;
  }

  let hours: number | undefined;
  if (fact.type === "time_entry") {
    hours = fact.fields.hours;
    if (hours === undefined && fact.fields.startTime && fact.fields.endTime) {
      hours = computeShiftHours(fact.fields.startTime, fact.fields.endTime) ?? undefined;
    }
    if (hours === undefined || !isPlausibleHours(hours)) {
      return {
        status: "needs_clarification",
        fact,
        reason: "implausible_time",
        opsCase: await implausibleTimeCase(ctx, fact),
      };
    }
  } else if (fact.type === "equipment_usage" && fact.fields.hours !== undefined) {
    hours = fact.fields.hours;
    if (!isPlausibleHours(hours)) {
      return {
        status: "needs_clarification",
        fact,
        reason: "implausible_time",
        opsCase: await implausibleTimeCase(ctx, fact),
      };
    }
  }

  return { status: "valid", fact, entities, hours };
}
