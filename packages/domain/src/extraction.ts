// Provider-independent LLM extraction contract (ARCHITECTURE.md §8, §15; CLAUDE.md rule 9-10).
// Every AI-extracted fact carries per-field confidence and evidence, plus any unresolved
// questions the model could not answer — a low-confidence or ambiguous fact must stay a draft
// and raise a clarification, never a guess (CLAUDE.md rule 14, MASTER_SPEC.md §15). Nothing here
// imports a vendor SDK: implementations live behind an adapter in packages/integrations or a
// deterministic fixture used in tests.

import { z } from "zod";

export const FIELD_CAPTURE_FACT_TYPES = [
  "time_entry",
  "equipment_usage",
  "material_usage",
  "job_note",
  "billable_opportunity",
] as const;
export type FieldCaptureFactType = (typeof FIELD_CAPTURE_FACT_TYPES)[number];

const ref = (max: number) => z.string().trim().min(1).max(max);
const confidenceScore = z.number().min(0).max(1);

/** A quote from the source message that backs an extracted value, for owner/operator review. */
export const evidenceSpanSchema = z.object({
  field: z.string().trim().min(1).max(100),
  quote: z.string().trim().min(1).max(500),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
});
export type EvidenceSpan = z.infer<typeof evidenceSpanSchema>;

/** Score, keyed by field name, in `fields`; every populated field should have an entry. */
const factConfidence = z.record(z.string(), confidenceScore);
const factCommon = {
  factKey: ref(200),
  confidence: factConfidence,
  evidence: z.array(evidenceSpanSchema).min(1),
};

/**
 * Raw, still-unmatched values ("Wilson", "Hoe", "D6") for one candidate operational fact. Job,
 * employee and equipment matching (M3-T11/T12) and threshold checks (M3-T13) happen after
 * extraction — nothing here is an authoritative record yet.
 */
export const fieldCaptureFactSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("time_entry"),
    fields: z.object({
      employeeRef: ref(200),
      jobRef: ref(200).optional(),
      workDate: ref(32).optional(),
      startTime: ref(32).optional(),
      endTime: ref(32).optional(),
      hours: z.number().nonnegative().max(100).optional(),
    }),
    ...factCommon,
  }),
  z.object({
    type: z.literal("equipment_usage"),
    fields: z.object({
      equipmentRef: ref(200),
      jobRef: ref(200).optional(),
      hours: z.number().nonnegative().max(100).optional(),
    }),
    ...factCommon,
  }),
  z.object({
    type: z.literal("material_usage"),
    fields: z.object({
      jobRef: ref(200).optional(),
      description: ref(500),
      quantity: z.number().nonnegative().max(1_000_000).optional(),
      unit: z.string().trim().max(32).optional(),
    }),
    ...factCommon,
  }),
  z.object({
    type: z.literal("job_note"),
    fields: z.object({
      jobRef: ref(200).optional(),
      body: ref(4000),
    }),
    ...factCommon,
  }),
  z.object({
    type: z.literal("billable_opportunity"),
    fields: z.object({
      jobRef: ref(200).optional(),
      description: ref(500),
      quantity: z.number().nonnegative().max(1_000_000).optional(),
      unit: z.string().trim().max(32).optional(),
    }),
    ...factCommon,
  }),
]);
export type FieldCaptureFact = z.infer<typeof fieldCaptureFactSchema>;

/** A gap the extractor could not resolve — routed to a human, never guessed (CLAUDE.md rule 14). */
export const unresolvedQuestionSchema = z.object({
  question: ref(500),
  relatedFactKey: ref(200).optional(),
  evidence: z.array(evidenceSpanSchema).default([]),
});
export type UnresolvedQuestion = z.infer<typeof unresolvedQuestionSchema>;

export const fieldCaptureExtractionSchema = z.object({
  facts: z.array(fieldCaptureFactSchema).max(200),
  unresolvedQuestions: z.array(unresolvedQuestionSchema).max(50).default([]),
});
export type FieldCaptureExtraction = z.infer<typeof fieldCaptureExtractionSchema>;

/** Source message plus tenant scoping handed to any StructuredExtractor. */
export interface ExtractionInput {
  organizationId: string;
  sourceCommunicationId: string;
  text: string;
}

export interface ExtractionResult<T> {
  data: T;
  modelVersion: string;
}

/**
 * Provider-independent LLM contract (ARCHITECTURE.md §8). An LLM adapter in packages/integrations
 * or a deterministic test fixture implements this; callers never see a vendor SDK type.
 */
export interface StructuredExtractor<T> {
  extract(input: ExtractionInput): Promise<ExtractionResult<T>>;
}
