import { describe, expect, it } from "vitest";
import {
  addMemberInput,
  createApprovalInput,
  createTaskInput,
  grantOperatorAccessInput,
  parseInput,
  updateOpsCaseInput,
  ValidationError,
} from "../src";

describe("input schemas", () => {
  it("requires entityType and entityId together", () => {
    expect(() => parseInput(createTaskInput, { title: "x", entityType: "job" })).toThrow(
      ValidationError,
    );
    expect(
      parseInput(createTaskInput, {
        title: "x",
        entityType: "job",
        entityId: "00000000-0000-4000-8000-000000000001",
      }).priority,
    ).toBe("normal");
  });

  it("requires an idempotency key on approvals", () => {
    expect(() => parseInput(createApprovalInput, { type: "purchase", title: "Rock" })).toThrow(
      ValidationError,
    );
  });

  it("rejects negative amounts", () => {
    expect(() =>
      parseInput(createApprovalInput, {
        type: "purchase",
        title: "Rock",
        amountCents: -1,
        idempotencyKey: "purchase-123",
      }),
    ).toThrow(ValidationError);
  });

  it("does not allow adding owners through addMember", () => {
    expect(() => parseInput(addMemberInput, { email: "a@b.co", role: "owner" })).toThrow(
      ValidationError,
    );
  });

  it("caps operator grants at 7 days", () => {
    expect(() =>
      parseInput(grantOperatorAccessInput, {
        operatorEmail: "ops@x.co",
        reason: "investigate case",
        durationHours: 24 * 8,
      }),
    ).toThrow(ValidationError);
  });

  it("requires a resolution to resolve an ops case", () => {
    expect(() => parseInput(updateOpsCaseInput, { status: "resolved" })).toThrow(ValidationError);
  });
});
