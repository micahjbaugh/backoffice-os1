// POST /api/internal/jobs: disabled without a strong secret, bearer-authenticated, fails closed when
// providers are not configured.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runBackgroundJobs } = vi.hoisted(() => ({ runBackgroundJobs: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@backoffice/workflows", () => ({ runBackgroundJobs }));
vi.mock("../src/server/db", () => ({ db: () => ({}) }));

const SECRET = "j".repeat(40);
const post = (auth?: string) =>
  new Request("https://app.example.com/api/internal/jobs", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });

let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  vi.resetModules();
  (globalThis as { backofficeProviderRuntime?: unknown }).backofficeProviderRuntime = undefined;
  runBackgroundJobs.mockReset().mockResolvedValue({ webhooks: { claimed: 0 } });
});
afterEach(() => {
  process.env = env;
});

async function handler() {
  return (await import("../src/server/jobs-endpoint")).handleJobsRequest;
}

describe("jobs endpoint", () => {
  it("is disabled (503) until a strong secret is configured", async () => {
    delete process.env.INTERNAL_JOBS_SECRET;
    expect((await (await handler())(post(`Bearer anything`))).status).toBe(503);
    process.env.INTERNAL_JOBS_SECRET = "short";
    expect((await (await handler())(post(`Bearer short`))).status).toBe(503);
    expect(runBackgroundJobs).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong bearer tokens", async () => {
    process.env.INTERNAL_JOBS_SECRET = SECRET;
    const handle = await handler();
    expect((await handle(post())).status).toBe(401);
    expect((await handle(post(`Bearer ${SECRET}x`))).status).toBe(401);
    expect(runBackgroundJobs).not.toHaveBeenCalled();
  });

  it("fails closed when providers are not configured", async () => {
    Object.assign(process.env, {
      INTERNAL_JOBS_SECRET: SECRET,
      NODE_ENV: "production",
      BO_PROVIDER_MODE: "",
    });
    delete process.env.TWILIO_ACCOUNT_SID;
    const res = await (await handler())(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(runBackgroundJobs).not.toHaveBeenCalled();
  });

  it("runs one pass of jobs with the right token", async () => {
    Object.assign(process.env, {
      INTERNAL_JOBS_SECRET: SECRET,
      NODE_ENV: "development",
      BO_PROVIDER_MODE: "fake",
      FAKE_PROVIDER_WEBHOOK_SECRET: "a-local-dev-secret-123",
    });
    const res = await (await handler())(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(runBackgroundJobs).toHaveBeenCalledTimes(1);
  });
});
