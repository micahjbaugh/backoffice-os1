import {
  fieldCaptureExtractionSchema,
  type ExtractionInput,
  type ExtractionResult,
  type FieldCaptureExtraction,
  type StructuredExtractor,
} from "@backoffice/domain";

/** The exact inbound text used by the M3 acceptance criteria (MILESTONES.md). */
export const FIELD_CAPTURE_ACCEPTANCE_MESSAGE =
  "Me Jake Tyler 7-5:30 Wilson. Hoe 8 hrs D6 6.5, 21 ton rock. Customer had us grade another 200 ft.";

/**
 * The extraction a real LLM adapter (M3-T10) should produce for
 * FIELD_CAPTURE_ACCEPTANCE_MESSAGE: one time entry, two equipment usages, one material usage, a
 * job note and a billable opportunity, each with per-field confidence and quoted evidence.
 */
export const FIELD_CAPTURE_ACCEPTANCE_EXTRACTION: FieldCaptureExtraction = {
  facts: [
    {
      factKey: "time-1",
      type: "time_entry",
      fields: { employeeRef: "Jake Tyler", jobRef: "Wilson", startTime: "7:00", endTime: "5:30" },
      confidence: { employeeRef: 0.95, jobRef: 0.6, startTime: 0.85, endTime: 0.85 },
      evidence: [{ field: "employeeRef", quote: "Me Jake Tyler 7-5:30 Wilson" }],
    },
    {
      factKey: "equip-1",
      type: "equipment_usage",
      fields: { equipmentRef: "Hoe", jobRef: "Wilson", hours: 8 },
      confidence: { equipmentRef: 0.7, hours: 0.9 },
      evidence: [{ field: "equipmentRef", quote: "Hoe 8 hrs" }],
    },
    {
      factKey: "equip-2",
      type: "equipment_usage",
      fields: { equipmentRef: "D6", jobRef: "Wilson", hours: 6.5 },
      confidence: { equipmentRef: 0.7, hours: 0.9 },
      evidence: [{ field: "equipmentRef", quote: "D6 6.5" }],
    },
    {
      factKey: "material-1",
      type: "material_usage",
      fields: { jobRef: "Wilson", description: "rock", quantity: 21, unit: "ton" },
      confidence: { description: 0.85, quantity: 0.9 },
      evidence: [{ field: "description", quote: "21 ton rock" }],
    },
    {
      factKey: "note-1",
      type: "job_note",
      fields: { jobRef: "Wilson", body: "Customer had us grade another 200 ft" },
      confidence: { body: 0.9 },
      evidence: [{ field: "body", quote: "Customer had us grade another 200 ft" }],
    },
    {
      factKey: "billable-1",
      type: "billable_opportunity",
      fields: { jobRef: "Wilson", description: "grade another 200 ft", quantity: 200, unit: "ft" },
      confidence: { description: 0.85, quantity: 0.8 },
      evidence: [{ field: "description", quote: "Customer had us grade another 200 ft" }],
    },
  ],
  unresolvedQuestions: [],
};

/**
 * Deterministic StructuredExtractor for tests and local development (CLAUDE.md rule 9: no
 * vendor SDK, no network call). Looks up canned extractions by exact source text so acceptance
 * and workflow tests can exercise field capture without an LLM adapter; unregistered text throws
 * rather than guessing, matching the "never silently guess" rule that any real adapter must obey.
 */
export class FixtureStructuredExtractor implements StructuredExtractor<FieldCaptureExtraction> {
  readonly modelVersion = "fixture-1";
  private readonly fixtures = new Map<string, FieldCaptureExtraction>([
    [FIELD_CAPTURE_ACCEPTANCE_MESSAGE, FIELD_CAPTURE_ACCEPTANCE_EXTRACTION],
  ]);

  constructor(extraFixtures: Readonly<Record<string, FieldCaptureExtraction>> = {}) {
    for (const [text, extraction] of Object.entries(extraFixtures)) {
      this.fixtures.set(text, extraction);
    }
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult<FieldCaptureExtraction>> {
    const data = this.fixtures.get(input.text);
    if (!data) {
      throw new Error(`FixtureStructuredExtractor: no fixture registered for text: ${input.text}`);
    }
    return { data: fieldCaptureExtractionSchema.parse(data), modelVersion: this.modelVersion };
  }
}
