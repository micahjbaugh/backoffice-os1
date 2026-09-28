// PH-T01: sign-in must be rate limited before any credential check reaches the identity provider.
// auth.ts pulls in `@/...` aliases vitest doesn't resolve (unlike the real Next build), so this is
// a static guard on the source rather than an executed unit test; the rate limiter's own behavior
// (key construction, throwing once denied) is covered in rate-limit.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "../src/app/actions/auth.ts"), "utf8");

describe("signInAction", () => {
  it("enforces the sign-in rate limit before calling the identity provider", () => {
    const start = source.indexOf("export async function signInAction");
    const end = source.indexOf("export async function signUpAction");
    const body = source.slice(start, end);
    expect(body).toMatch(/enforceSignInRateLimit\(/);
    const rateLimitCallIndex = body.indexOf("enforceSignInRateLimit(");
    const signInCallIndex = body.indexOf("auth.signInWithPassword(");
    expect(rateLimitCallIndex).toBeGreaterThan(-1);
    expect(signInCallIndex).toBeGreaterThan(rateLimitCallIndex);
  });
});
