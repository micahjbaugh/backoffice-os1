// PH-T01: withTenant/withOperator are the single choke point every tenant/operator server action
// goes through (see boundaries.test.ts), so per-tenant/per-operator rate limiting lives here. The
// limiter's own semantics are covered elsewhere; this proves the check runs, and blocks the action
// when it fails, rather than being wired up wrong or skipped.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getInternalStaff,
  inTenant,
  listMyOrganizations,
  runAs,
  enforceServerActionRateLimit,
  getUser,
} = vi.hoisted(() => ({
  getInternalStaff: vi.fn(),
  inTenant: vi.fn((tx: unknown, organizationId: unknown) => ({ tx, organizationId })),
  listMyOrganizations: vi.fn(),
  runAs: vi.fn((_db: unknown, actor: unknown, fn: (tx: unknown) => unknown) => fn({ actor })),
  enforceServerActionRateLimit: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
vi.mock("@backoffice/core", () => ({ getInternalStaff, inTenant, listMyOrganizations, runAs }));
vi.mock("../src/server/auth/supabase", () => ({ supabaseAuth: { getUser } }));
vi.mock("../src/server/db", () => ({ db: () => ({}) }));
vi.mock("../src/server/rate-limit", () => ({ enforceServerActionRateLimit }));

const { withOperator, withTenant } = await import("../src/server/session");

beforeEach(() => {
  getInternalStaff.mockReset().mockResolvedValue(null);
  listMyOrganizations
    .mockReset()
    .mockResolvedValue([{ organization: { id: "org-1", name: "Org" }, role: "owner" }]);
  runAs.mockClear();
  enforceServerActionRateLimit.mockReset().mockResolvedValue(undefined);
  getUser.mockReset().mockResolvedValue({ id: "user-1", email: "a@b.test" });
});

describe("withTenant", () => {
  it("enforces the tenant's rate limit before running the action", async () => {
    const action = vi.fn(async () => "ok");
    await withTenant(action);
    expect(enforceServerActionRateLimit).toHaveBeenCalledWith("tenant:org-1");
    expect(action).toHaveBeenCalled();
  });

  it("never runs the action when the tenant is rate limited", async () => {
    const { RateLimitedError } = await import("@backoffice/domain");
    enforceServerActionRateLimit.mockRejectedValueOnce(new RateLimitedError(1_000));
    const action = vi.fn(async () => "ok");
    await expect(withTenant(action)).rejects.toBeInstanceOf(RateLimitedError);
    expect(action).not.toHaveBeenCalled();
  });
});

describe("withOperator", () => {
  beforeEach(() => {
    getInternalStaff.mockResolvedValue({ id: "staff-1", role: "ops_agent" });
  });

  it("enforces the operator's rate limit before running the action", async () => {
    const action = vi.fn(async () => "ok");
    await withOperator(action);
    expect(enforceServerActionRateLimit).toHaveBeenCalledWith("operator:user-1");
    expect(action).toHaveBeenCalled();
  });

  it("never runs the action when the operator is rate limited", async () => {
    const { RateLimitedError } = await import("@backoffice/domain");
    enforceServerActionRateLimit.mockRejectedValueOnce(new RateLimitedError(1_000));
    const action = vi.fn(async () => "ok");
    await expect(withOperator(action)).rejects.toBeInstanceOf(RateLimitedError);
    expect(action).not.toHaveBeenCalled();
  });
});
