// PH-T01: the Postgres-backed limiter enforces a fixed window per bucket key, independently of
// other keys, and resets once the window rolls over.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RateLimitedError } from "@backoffice/domain";
import { createPostgresRateLimiter, enforceRateLimit, type RateLimiter } from "../src";
import { createTestDatabase, type TestDatabase } from "./helpers/db";

let t: TestDatabase;
let limiter: RateLimiter;

beforeAll(async () => {
  t = await createTestDatabase();
  limiter = createPostgresRateLimiter(t.db);
});
afterAll(async () => {
  await t.close();
});

describe("createPostgresRateLimiter", () => {
  it("allows requests under the limit and blocks once it is exceeded", async () => {
    const key = `test:${randomUUID()}`;
    const first = await limiter.consume(key, 2, 60_000);
    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    const second = await limiter.consume(key, 2, 60_000);
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
    const third = await limiter.consume(key, 2, 60_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks independent keys separately", async () => {
    const a = `test:${randomUUID()}`;
    const b = `test:${randomUUID()}`;
    await limiter.consume(a, 1, 60_000);
    const blockedA = await limiter.consume(a, 1, 60_000);
    const allowedB = await limiter.consume(b, 1, 60_000);
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it("resets once the window rolls over", async () => {
    // A pinned clock, so the first two calls can never straddle a window boundary on a slow runner.
    const key = `test:${randomUUID()}`;
    const windowMs = 60_000;
    const start = Math.floor(Date.now() / windowMs) * windowMs + 1;
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      await limiter.consume(key, 1, windowMs);
      expect((await limiter.consume(key, 1, windowMs)).allowed).toBe(false);
      now.mockReturnValue(start + windowMs);
      expect((await limiter.consume(key, 1, windowMs)).allowed).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});

describe("enforceRateLimit", () => {
  it("throws RateLimitedError once the limiter denies", async () => {
    const key = `test:${randomUUID()}`;
    await enforceRateLimit(limiter, key, 1, 60_000);
    await expect(enforceRateLimit(limiter, key, 1, 60_000)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});
