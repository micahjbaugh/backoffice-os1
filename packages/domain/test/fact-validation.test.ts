import { describe, expect, it } from "vitest";
import {
  computeShiftHours,
  isDuplicateFact,
  isPlausibleHours,
  meetsConfidenceThreshold,
  parseClockTime,
  type FieldCaptureFact,
} from "../src";

describe("meetsConfidenceThreshold", () => {
  it("passes when every scored field is at or above the threshold", () => {
    expect(meetsConfidenceThreshold({ employeeRef: 0.95, jobRef: 0.65 })).toBe(true);
  });

  it("fails when any scored field is below the threshold", () => {
    expect(meetsConfidenceThreshold({ employeeRef: 0.95, jobRef: 0.4 })).toBe(false);
  });

  it("passes vacuously when there are no scored fields", () => {
    expect(meetsConfidenceThreshold({})).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(meetsConfidenceThreshold({ jobRef: 0.5 }, 0.9)).toBe(false);
    expect(meetsConfidenceThreshold({ jobRef: 0.5 }, 0.5)).toBe(true);
  });
});

describe("parseClockTime", () => {
  it.each([
    ["7", 7],
    ["7:00", 7],
    ["5:30", 5.5],
    ["05:30", 5.5],
    ["5:30pm", 17.5],
    ["12:00am", 0],
    ["12:00pm", 12],
  ])("parses %s as %s", (raw, expected) => {
    expect(parseClockTime(raw)).toBeCloseTo(expected);
  });

  it.each(["not a time", "25:00", "7:99", ""])("rejects %s", (raw) => {
    expect(parseClockTime(raw)).toBeNull();
  });
});

describe("computeShiftHours", () => {
  it("computes 10.5h for the acceptance shorthand '7-5:30'", () => {
    expect(computeShiftHours("7:00", "5:30")).toBeCloseTo(10.5);
  });

  it("does not roll an already-later end time forward another 12 hours", () => {
    expect(computeShiftHours("7:00", "3:00pm")).toBeCloseTo(8);
  });

  it("returns null when either side isn't a clock time", () => {
    expect(computeShiftHours("junk", "5:30")).toBeNull();
    expect(computeShiftHours("7:00", "junk")).toBeNull();
  });

  it("returns null for a non-positive shift", () => {
    expect(computeShiftHours("7:00am", "7:00am")).toBeNull();
  });
});

describe("isPlausibleHours", () => {
  it("accepts a normal shift length", () => {
    expect(isPlausibleHours(10.5)).toBe(true);
  });

  it("rejects zero or negative hours", () => {
    expect(isPlausibleHours(0)).toBe(false);
    expect(isPlausibleHours(-1)).toBe(false);
  });

  it("rejects a shift longer than a day allows", () => {
    expect(isPlausibleHours(20)).toBe(false);
  });

  it("honors a custom max", () => {
    expect(isPlausibleHours(20, 24)).toBe(true);
  });
});

function equipmentFact(factKey: string, equipmentRef: string, hours: number): FieldCaptureFact {
  return {
    factKey,
    type: "equipment_usage",
    fields: { equipmentRef, jobRef: "Wilson", hours },
    confidence: { equipmentRef: 0.9, hours: 0.9 },
    evidence: [{ field: "equipmentRef", quote: equipmentRef }],
  };
}

describe("isDuplicateFact", () => {
  it("flags a fact whose type and fields match another fact in the batch", () => {
    const a = equipmentFact("equip-1", "Hoe", 8);
    const b = equipmentFact("equip-1b", "Hoe", 8);
    expect(isDuplicateFact(a, [b])).toBe(true);
  });

  it("is case- and whitespace-insensitive on string fields", () => {
    const a = equipmentFact("equip-1", "Hoe", 8);
    const b = equipmentFact("equip-1b", "  HOE ", 8);
    expect(isDuplicateFact(a, [b])).toBe(true);
  });

  it("does not flag facts with different field values", () => {
    const a = equipmentFact("equip-1", "Hoe", 8);
    const b = equipmentFact("equip-2", "D6", 6.5);
    expect(isDuplicateFact(a, [b])).toBe(false);
  });

  it("ignores itself when it appears in the comparison list", () => {
    const a = equipmentFact("equip-1", "Hoe", 8);
    expect(isDuplicateFact(a, [a])).toBe(false);
  });

  it("flags duplicates regardless of the order fields were inserted in", () => {
    const a = equipmentFact("equip-1", "Hoe", 8);
    const b: FieldCaptureFact = {
      factKey: "equip-1b",
      type: "equipment_usage",
      // Same fields as `a` but built with reversed key insertion order, so a signature that
      // relies on JSON.stringify's key order (rather than sorting first) would miss this match.
      fields: { hours: 8, jobRef: "Wilson", equipmentRef: "Hoe" },
      confidence: { hours: 0.9, equipmentRef: 0.9 },
      evidence: [{ field: "equipmentRef", quote: "Hoe" }],
    };
    expect(isDuplicateFact(a, [b])).toBe(true);
  });
});
