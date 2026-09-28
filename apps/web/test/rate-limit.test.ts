// PH-T01: the app-level wiring (key construction, per-surface limits) on top of the storage-backed
// limiter. The limiter itself (Postgres semantics) is covered in packages/core/test/rate-limit.test.ts;
// here it is faked so this stays a fast, DB-free unit test of the wiring.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@backoffice/core";

const { consume } = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../src/server/db", () => ({ db: () => ({}) }));
vi.mock("@backoffice/core", async () => {
  const actual = await vi.importActual<typeof CoreModule>("@backoffice/core");
  return { ...actual, createPostgresRateLimiter: () => ({ consume }) };
});

const allow = (remaining = 0) => ({ allowed: true, remaining, retryAfterMs: 0 });
const deny = (retryAfterMs = 1000) => ({ allowed: false, remaining: 0, retryAfterMs });

function headers(value: Record<string, string>) {
  return { get: (name: string) => value[name.toLowerCase()] ?? null };
}

beforeEach(() => {
  consume.mockReset().mockResolvedValue(allow());
  (globalThis as { backofficeRateLimiter?: unknown }).backofficeRateLimiter = undefined;
});

describe("clientIp", () => {
  it("takes the first address from X-Forwarded-For", async () => {
    const { clientIp } = await import("../src/server/rate-limit");
    expect(clientIp(headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP, then unknown", async () => {
    const { clientIp } = await import("../src/server/rate-limit");
    expect(clientIp(headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(headers({}))).toBe("unknown");
  });
});

describe("enforceWebhookRateLimit", () => {
  it("keys by provider and IP, and passes when allowed", async () => {
    const { enforceWebhookRateLimit } = await import("../src/server/rate-limit");
    const request = new Request("https://app.example.com/api/webhooks/sms", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    await enforceWebhookRateLimit(request, "twilio");
    expect(consume).toHaveBeenCalledWith(
      "webhook:twilio:1.2.3.4",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("throws RateLimitedError when denied", async () => {
    consume.mockResolvedValueOnce(deny(5000));
    const { enforceWebhookRateLimit, RateLimitedError } = await import("../src/server/rate-limit");
    const request = new Request("https://app.example.com/api/webhooks/sms");
    await expect(enforceWebhookRateLimit(request, "twilio")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});

describe("enforceSignInRateLimit", () => {
  it("checks both the IP and the email budget", async () => {
    const { enforceSignInRateLimit } = await import("../src/server/rate-limit");
    await enforceSignInRateLimit("1.2.3.4", "Owner@Example.com");
    expect(consume).toHaveBeenCalledWith(
      "signin:ip:1.2.3.4",
      expect.any(Number),
      expect.any(Number),
    );
    expect(consume).toHaveBeenCalledWith(
      "signin:email:owner@example.com",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("fails on the IP budget without checking email", async () => {
    consume.mockResolvedValueOnce(deny());
    const { enforceSignInRateLimit, RateLimitedError } = await import("../src/server/rate-limit");
    await expect(enforceSignInRateLimit("1.2.3.4", "a@b.test")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(consume).toHaveBeenCalledTimes(1);
  });
});

describe("enforceServerActionRateLimit", () => {
  it("scopes the bucket key to the caller-provided scope", async () => {
    const { enforceServerActionRateLimit } = await import("../src/server/rate-limit");
    await enforceServerActionRateLimit("tenant:org-1");
    expect(consume).toHaveBeenCalledWith(
      "action:tenant:org-1",
      expect.any(Number),
      expect.any(Number),
    );
  });
});
