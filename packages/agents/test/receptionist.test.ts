import { describe, expect, it } from "vitest";
import {
  RECEPTIONIST_FALLBACK_MESSAGE,
  RECEPTIONIST_FALLBACK_PROMPT,
  RECEPTIONIST_PROMPT,
  receptionistAgent,
  receptionistGreeting,
  receptionistTools,
  renderPrompt,
} from "../src";

describe("receptionist tool contracts", () => {
  it("only exposes green-risk tools (non-human actors are green-only, packages/domain/permissions.ts)", () => {
    for (const tool of Object.values(receptionistTools)) {
      expect(tool.riskClass).toBe("green");
    }
  });

  it("create_lead accepts a qualified lead and rejects one with no idempotency key", () => {
    const tool = receptionistTools.create_lead;
    expect(
      tool?.inputSchema.safeParse({
        source: "voice",
        firstName: "Jane",
        phone: "+15551234567",
        idempotencyKey: "call-abc123",
      }).success,
    ).toBe(true);
    expect(tool?.inputSchema.safeParse({ source: "voice", firstName: "Jane" }).success).toBe(false);
  });

  it("create_callback_task requires a communication link and a title", () => {
    const tool = receptionistTools.create_callback_task;
    expect(
      tool?.inputSchema.safeParse({
        communicationId: "11111111-1111-4111-8111-111111111111",
        title: "Call back about quote",
      }).success,
    ).toBe(true);
    expect(tool?.inputSchema.safeParse({ title: "Call back about quote" }).success).toBe(false);
  });

  it("request_transfer requires a known reason code", () => {
    const tool = receptionistTools.request_transfer;
    expect(
      tool?.inputSchema.safeParse({
        communicationId: "11111111-1111-4111-8111-111111111111",
        reason: "caller_requested_human",
      }).success,
    ).toBe(true);
    expect(
      tool?.inputSchema.safeParse({
        communicationId: "11111111-1111-4111-8111-111111111111",
        reason: "because",
      }).success,
    ).toBe(false);
  });

  it("lookup_business_info only allows known topics", () => {
    const tool = receptionistTools.lookup_business_info;
    expect(tool?.inputSchema.safeParse({ topic: "hours" }).success).toBe(true);
    expect(tool?.inputSchema.safeParse({ topic: "pricing" }).success).toBe(false);
  });
});

describe("receptionist prompt", () => {
  it("is versioned and disclaims authorization logic", () => {
    expect(RECEPTIONIST_PROMPT.agent).toBe("receptionist");
    expect(RECEPTIONIST_PROMPT.version).toBe(1);
    expect(RECEPTIONIST_PROMPT.template).not.toMatch(/you (may|can) approve/i);
    expect(RECEPTIONIST_PROMPT.template).toMatch(/validated and authorized by the server/i);
  });

  it("fills placeholders and fails closed on a missing value", () => {
    const rendered = renderPrompt(receptionistAgent.prompt, {
      business_name: "Acme Plumbing",
      business_hours: "Mon-Fri 8am-5pm",
    });
    expect(rendered).toContain("Acme Plumbing");
    expect(rendered).not.toContain("{{");
    expect(() => renderPrompt(receptionistAgent.prompt, {})).toThrow(/missing value/);
  });

  it("names every tool it can call as an actual tool contract", () => {
    for (const toolName of Object.keys(receptionistTools)) {
      expect(RECEPTIONIST_PROMPT.template).toContain(toolName);
    }
  });
});

describe("receptionistAgent", () => {
  it("bundles the prompt and the bounded tool set", () => {
    expect(receptionistAgent.name).toBe("receptionist");
    expect(receptionistAgent.tools).toBe(receptionistTools);
  });
});

describe("receptionist fallback (unknown number or missing tenant config)", () => {
  it("greets by name for a resolved call", () => {
    expect(receptionistGreeting("Acme Plumbing")).toContain("Acme Plumbing");
  });

  it("has no tools and never promises action or a transfer", () => {
    expect(RECEPTIONIST_FALLBACK_MESSAGE.length).toBeGreaterThan(0);
    expect(RECEPTIONIST_FALLBACK_PROMPT.template).not.toMatch(/you (may|can) approve/i);
    expect(RECEPTIONIST_FALLBACK_PROMPT.template).toMatch(/do not.*transfer/i);
  });
});
