// M3-T14: field capture workflow (ARCHITECTURE.md §4 step-by-step example: crew text). One
// function drives the whole pipeline for one inbound message: extract (StructuredExtractor,
// M3-T10) -> validate (M3-T11/T12/T13: known employee/job/equipment, plausible time, duplicate,
// confidence) -> draft or clarification (./field-capture-drafts.ts) -> audit (drafts get a
// row-audit trigger + business event from their own service; clarifications get an ops case,
// which audits itself).
//
// Idempotent per communication: the whole run is gated on one business event
// (`field_capture.processed:${sourceCommunicationId}`), recorded first and unique on
// (organization_id, idempotency_key). A replay finds that event already recorded and returns
// immediately — nothing is re-extracted, re-validated, drafted or reopened as a clarification.
// Draft rows are additionally idempotent per (source_communication_id, fact_key) (0010), so even a
// crash between the marker and the drafts only risks a duplicate ops case on manual retry, never a
// duplicate draft.

import {
  EVENT_TYPES,
  type FieldCaptureExtraction,
  type FieldCaptureFact,
  type StructuredExtractor,
  type UnresolvedQuestion,
  type UUID,
} from "@backoffice/domain";
import type { ServiceContext } from "../runtime";
import { assertCommunicationInOrg } from "./entities";
import { recordEvent } from "./events";
import { draftForFact, type FieldCaptureFactOutcome } from "./field-capture-drafts";
import { validateFieldCaptureFact } from "./fact-validator";
import { createOpsCase } from "./ops";

export type { FieldCaptureFactOutcome } from "./field-capture-drafts";

export interface FieldCaptureRunResult {
  /** False when this source communication was already processed: everything below is empty. */
  processed: boolean;
  outcomes: FieldCaptureFactOutcome[];
  /** Ops case ids opened for gaps the extractor flagged itself, not tied to one candidate fact. */
  unresolvedQuestionCaseIds: UUID[];
}

export interface RunFieldCaptureWorkflowInput {
  sourceCommunicationId: UUID;
  text: string;
  extractor: StructuredExtractor<FieldCaptureExtraction>;
}

/** A gap the extractor itself flagged (never tied to one fact it could confidently emit) — routed
 *  to a human exactly like a low-confidence fact (CLAUDE.md rule 14), never guessed. */
async function openUnresolvedQuestionCase(
  ctx: ServiceContext,
  question: UnresolvedQuestion,
): Promise<UUID> {
  const opsCase = await createOpsCase(ctx, {
    title: `Unresolved: ${question.question}`,
    reasonCode: "missing_data",
    priority: "normal",
    evidence: {
      question: question.question,
      related_fact_key: question.relatedFactKey ?? null,
      evidence: question.evidence,
    },
  });
  return opsCase.id;
}

/**
 * Run the field capture workflow for one inbound crew message, already recorded as
 * `sourceCommunicationId` (M2 communications pipeline). Extracts structured facts with
 * `extractor`, validates each one, and either drafts it, opens a clarification, or (duplicates,
 * deferred billable opportunities) does nothing further — all inside the caller's transaction.
 */
export async function runFieldCaptureWorkflow(
  ctx: ServiceContext,
  input: RunFieldCaptureWorkflowInput,
): Promise<FieldCaptureRunResult> {
  await assertCommunicationInOrg(ctx, input.sourceCommunicationId);

  const marker = await recordEvent(ctx, {
    type: EVENT_TYPES.fieldCaptureProcessed,
    entityType: "communication",
    entityId: input.sourceCommunicationId,
    idempotencyKey: `field_capture.processed:${input.sourceCommunicationId}`,
  });
  if (!marker.created) return { processed: false, outcomes: [], unresolvedQuestionCaseIds: [] };

  const extraction = await input.extractor.extract({
    organizationId: ctx.organizationId,
    sourceCommunicationId: input.sourceCommunicationId,
    text: input.text,
  });

  const outcomes: FieldCaptureFactOutcome[] = [];
  const priorFacts: FieldCaptureFact[] = [];
  for (const fact of extraction.data.facts) {
    const validation = await validateFieldCaptureFact(ctx, fact, priorFacts);
    priorFacts.push(fact);

    if (validation.status === "duplicate") {
      outcomes.push({ factKey: fact.factKey, type: fact.type, status: "duplicate" });
    } else if (validation.status === "needs_clarification") {
      outcomes.push({
        factKey: fact.factKey,
        type: fact.type,
        status: "needs_clarification",
        reason: validation.reason,
        opsCaseId: validation.opsCase.id,
      });
    } else {
      outcomes.push(
        await draftForFact(
          ctx,
          input.sourceCommunicationId,
          fact,
          validation.entities,
          validation.hours,
        ),
      );
    }
  }

  const unresolvedQuestionCaseIds: UUID[] = [];
  for (const question of extraction.data.unresolvedQuestions) {
    unresolvedQuestionCaseIds.push(await openUnresolvedQuestionCase(ctx, question));
  }

  return { processed: true, outcomes, unresolvedQuestionCaseIds };
}
