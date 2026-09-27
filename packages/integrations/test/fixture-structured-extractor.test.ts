import { fieldCaptureExtractionSchema } from "@backoffice/domain";
import { describe, expect, it } from "vitest";
import {
  FIELD_CAPTURE_ACCEPTANCE_EXTRACTION,
  FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
  FixtureStructuredExtractor,
} from "../src";

describe("FixtureStructuredExtractor", () => {
  it("returns the M3 acceptance extraction for the acceptance message, and it validates", async () => {
    const extractor = new FixtureStructuredExtractor();
    const result = await extractor.extract({
      organizationId: "org-1",
      sourceCommunicationId: "comm-1",
      text: FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
    });

    expect(fieldCaptureExtractionSchema.safeParse(result.data).success).toBe(true);
    expect(result.data).toEqual(FIELD_CAPTURE_ACCEPTANCE_EXTRACTION);
    expect(result.modelVersion).toBe("fixture-1");

    const types = result.data.facts.map((fact) => fact.type);
    expect(types).toEqual([
      "time_entry",
      "equipment_usage",
      "equipment_usage",
      "material_usage",
      "job_note",
      "billable_opportunity",
    ]);
  });

  it("is deterministic: replaying the same text returns an identical extraction", async () => {
    const extractor = new FixtureStructuredExtractor();
    const input = {
      organizationId: "org-1",
      sourceCommunicationId: "comm-1",
      text: FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
    };
    const first = await extractor.extract(input);
    const second = await extractor.extract(input);
    expect(first).toEqual(second);
  });

  it("accepts extra caller-registered fixtures without losing the built-in one", async () => {
    const extractor = new FixtureStructuredExtractor({
      "custom text": { facts: [], unresolvedQuestions: [] },
    });

    const custom = await extractor.extract({
      organizationId: "org-1",
      sourceCommunicationId: "comm-2",
      text: "custom text",
    });
    expect(custom.data).toEqual({ facts: [], unresolvedQuestions: [] });

    const acceptance = await extractor.extract({
      organizationId: "org-1",
      sourceCommunicationId: "comm-1",
      text: FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
    });
    expect(acceptance.data).toEqual(FIELD_CAPTURE_ACCEPTANCE_EXTRACTION);
  });

  it("throws rather than guessing when no fixture is registered for the text", async () => {
    const extractor = new FixtureStructuredExtractor();
    await expect(
      extractor.extract({
        organizationId: "org-1",
        sourceCommunicationId: "comm-3",
        text: "unregistered message",
      }),
    ).rejects.toThrow(/no fixture registered/);
  });
});
