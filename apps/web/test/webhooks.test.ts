// M2-T07: the webhook route handler verifies the provider signature via the adapter and records
// the receipt (M2-T06's idempotent service) before any further processing. Idempotency and RLS
// isolation for webhook_receipts itself are covered in packages/core/test/webhook-receipts.test.ts;
// this suite checks the HTTP-layer gate: invalid signatures are rejected, valid ones are recorded.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceProvider } from "@backoffice/integrations";

const { recordWebhookReceipt, runAs } = vi.hoisted(() => ({
  recordWebhookReceipt: vi.fn().mockResolvedValue({
    receipt: { id: "receipt-1", status: "received" },
    duplicate: false,
  }),
  runAs: vi.fn((_db: unknown, _actor: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

// "server-only" throws unconditionally outside Next's bundler (it relies on Next's webpack
// "react-server" export condition); stub it so src/server modules can be unit tested directly.
vi.mock("server-only", () => ({}));
vi.mock("@backoffice/core", () => ({ recordWebhookReceipt, runAs }));
vi.mock("../src/server/db", () => ({ db: () => ({}) }));

const { handleProviderWebhook } = await import("../src/server/webhook-route");

function request(body: string, signature?: string | null): Request {
  const headers = new Headers();
  if (signature) headers.set("x-fake-signature", signature);
  return new Request("https://example.test/api/webhooks/voice", {
    method: "POST",
    body,
    headers,
  });
}

describe("handleProviderWebhook", () => {
  beforeEach(() => {
    recordWebhookReceipt.mockClear();
    runAs.mockClear();
  });

  it("rejects a missing signature and records nothing", async () => {
    const provider = new FakeVoiceProvider();
    const body = JSON.stringify({ providerEventId: "evt-1" });
    const res = await handleProviderWebhook(provider, request(body));
    expect(res.status).toBe(401);
    expect(runAs).not.toHaveBeenCalled();
    expect(recordWebhookReceipt).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature and records nothing", async () => {
    const provider = new FakeVoiceProvider();
    const body = JSON.stringify({ providerEventId: "evt-1" });
    const res = await handleProviderWebhook(provider, request(body, "not-the-real-signature"));
    expect(res.status).toBe(401);
    expect(runAs).not.toHaveBeenCalled();
  });

  it("rejects a signature computed over a different body (tampering)", async () => {
    const provider = new FakeVoiceProvider();
    const original = JSON.stringify({ providerEventId: "evt-1" });
    const tampered = JSON.stringify({ providerEventId: "evt-1-tampered" });
    const res = await handleProviderWebhook(
      provider,
      request(tampered, provider.signWebhook(original)),
    );
    expect(res.status).toBe(401);
    expect(runAs).not.toHaveBeenCalled();
  });

  it("records exactly one receipt for a validly signed event", async () => {
    const provider = new FakeVoiceProvider();
    const body = JSON.stringify({ providerEventId: "evt-2", payload: { kind: "call.status" } });
    const res = await handleProviderWebhook(provider, request(body, provider.signWebhook(body)));
    expect(res.status).toBe(200);
    expect(runAs).toHaveBeenCalledTimes(1);
    expect(recordWebhookReceipt).toHaveBeenCalledTimes(1);
    expect(recordWebhookReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "fake-voice", providerEventId: "evt-2" }),
    );
  });

  it("rejects an unparseable body even with a valid signature", async () => {
    const provider = new FakeVoiceProvider();
    const body = "not json";
    const res = await handleProviderWebhook(provider, request(body, provider.signWebhook(body)));
    expect(res.status).toBe(400);
    expect(runAs).not.toHaveBeenCalled();
  });
});
