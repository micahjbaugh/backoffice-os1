import { describe, expect, it } from "vitest";
import {
  fieldCaptureExtractionSchema,
  fieldCaptureFactSchema,
  unresolvedQuestionSchema,
  type FieldCaptureExtraction,
} from "../src";

describe("fieldCaptureFactSchema", () => {
  it("accepts a time entry fact with per-field confidence and evidence", () => {
    const result = fieldCaptureFactSchema.safeParse({
      factKey: "time-1",
      type: "time_entry",
      fields: { employeeRef: "Jake Tyler", jobRef: "Wilson", startTime: "7:00", endTime: "5:30" },
      confidence: { employeeRef: 0.95, jobRef: 0.6, startTime: 0.9, endTime: 0.9 },
      evidence: [{ field: "employeeRef", quote: "Me Jake Tyler" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown fact type", () => {
    const result = fieldCaptureFactSchema.safeParse({
      factKey: "x-1",
      type: "purchase_order",
      fields: {},
      confidence: {},
      evidence: [{ field: "x", quote: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one evidence span", () => {
    const result = fieldCaptureFactSchema.safeParse({
      factKey: "eq-1",
      type: "equipment_usage",
      fields: { equipmentRef: "D6", jobRef: "Wilson", hours: 8 },
      confidence: { equipmentRef: 0.8, hours: 0.9 },
      evidence: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a confidence score outside 0-1", () => {
    const result = fieldCaptureFactSchema.safeParse({
      factKey: "mat-1",
      type: "material_usage",
      fields: { description: "21 ton rock", quantity: 21, unit: "ton" },
      confidence: { description: 1.5 },
      evidence: [{ field: "description", quote: "21 ton rock" }],
    });
    expect(result.success).toBe(false);
  });

  it("validates a billable opportunity fact from a customer-requested scope change", () => {
    const result = fieldCaptureFactSchema.safeParse({
      factKey: "billable-1",
      type: "billable_opportunity",
      fields: { jobRef: "Wilson", description: "grade another 200 ft", quantity: 200, unit: "ft" },
      confidence: { description: 0.85, quantity: 0.8 },
      evidence: [{ field: "description", quote: "Customer had us grade another 200 ft" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("unresolvedQuestionSchema", () => {
  it("defaults evidence to an empty array", () => {
    const result = unresolvedQuestionSchema.parse({ question: "Which job is D6 assigned to?" });
    expect(result.evidence).toEqual([]);
  });
});

describe("fieldCaptureExtractionSchema", () => {
  it("validates the M3 acceptance extraction: three facts, one note, one billable opportunity", () => {
    const extraction: FieldCaptureExtraction = {
      facts: [
        {
          factKey: "time-1",
          type: "time_entry",
          fields: {
            employeeRef: "Jake Tyler",
            jobRef: "Wilson",
            startTime: "7:00",
            endTime: "5:30",
          },
          confidence: { employeeRef: 0.95, jobRef: 0.6 },
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
          fields: {
            jobRef: "Wilson",
            description: "grade another 200 ft",
            quantity: 200,
            unit: "ft",
          },
          confidence: { description: 0.85, quantity: 0.8 },
          evidence: [{ field: "description", quote: "Customer had us grade another 200 ft" }],
        },
      ],
      unresolvedQuestions: [],
    };
    expect(fieldCaptureExtractionSchema.parse(extraction)).toEqual(extraction);
  });

  it("defaults unresolvedQuestions to an empty array", () => {
    const result = fieldCaptureExtractionSchema.parse({ facts: [] });
    expect(result.unresolvedQuestions).toEqual([]);
  });

  it("rejects a fact with an inconsistent field for its type", () => {
    const result = fieldCaptureExtractionSchema.safeParse({
      facts: [
        {
          factKey: "bad-1",
          type: "time_entry",
          fields: { hours: 8 },
          confidence: { hours: 0.9 },
          evidence: [{ field: "hours", quote: "8 hrs" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
