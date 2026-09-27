// End-to-end through the RUNNING app: a real production build served by `next start`, so requests
// pass through proxy.ts (the session gate) exactly as Twilio's, Vapi's or the scheduler's would. The
// route unit tests call handlers directly and cannot see the gate; this file exists because a gate
// that redirected every webhook to /login once passed all of them.
//
// Production refuses fake providers, so the app runs with live-mode configuration and freshly
// generated secrets, and requests are signed the way Twilio and Vapi sign them. No database is
// configured: a request that passes authentication fails at durable acceptance (500, so the
// provider retries), which proves it reached the handler. No provider is ever called.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TWILIO_ACCOUNT_SID,
  twilioInboundSms,
  twilioSign,
  vapiStatusUpdate,
} from "../../../packages/integrations/test/fixtures/providers";

const appDir = join(import.meta.dirname, "..");
const distDir = ".next-running-app-test";
const secret = () => randomBytes(24).toString("hex");
const TWILIO_AUTH_TOKEN = secret();
const VAPI_WEBHOOK_SECRET = secret();
const JOBS_SECRET = secret();
const TWILIO_WEBHOOK_URL = "https://app.backoffice.test/api/webhooks/sms";

const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "running-app-test-anon-key",
  DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:9/none",
  BO_PROVIDER_MODE: "live",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WEBHOOK_URL,
  VAPI_API_KEY: secret(),
  VAPI_WEBHOOK_SECRET,
  ANTHROPIC_API_KEY: secret(),
  INTERNAL_JOBS_SECRET: JOBS_SECRET,
  NEXT_DIST_DIR: distDir,
  NEXT_TELEMETRY_DISABLED: "1",
};

let server: ChildProcess | undefined;
let baseUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`server did not start at ${url}`);
}

beforeAll(async () => {
  rmSync(join(appDir, distDir), { recursive: true, force: true });
  const build = spawnSync("pnpm exec next build", {
    cwd: appDir,
    shell: true,
    encoding: "utf8",
    env,
  });
  if (build.status !== 0) {
    throw new Error(`next build failed (${build.status}):\n${build.stdout}\n${build.stderr}`);
  }
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(`pnpm exec next start -p ${port} -H 127.0.0.1`, { cwd: appDir, shell: true, env });
  await waitForServer(`${baseUrl}/login`, 60_000);
});

afterAll(() => {
  server?.kill();
  rmSync(join(appDir, distDir), { recursive: true, force: true });
});

const post = (path: string, body: string, headers: Record<string, string>) =>
  fetch(`${baseUrl}${path}`, { method: "POST", body, headers, redirect: "manual" });

const expectNoRedirect = (res: Response) => expect(res.headers.get("location")).toBeNull();

describe("running app: the session gate", () => {
  it("still sends signed-out visitors of app pages to /login (positive control)", async () => {
    const res = await fetch(`${baseUrl}/inbox`, { redirect: "manual" });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(new URL(res.headers.get("location") ?? "", baseUrl).pathname).toBe("/login");
  });
});

describe("running app: Twilio SMS webhooks reach their handler without a session", () => {
  const params = twilioInboundSms();
  const body = new URLSearchParams(params).toString();
  const form = { "content-type": "application/x-www-form-urlencoded" };

  it("rejects a bad signature in the handler (401), not with a login redirect", async () => {
    const res = await post("/api/webhooks/sms", body, { ...form, "x-twilio-signature": "bad" });
    expectNoRedirect(res);
    expect(res.status).toBe(401);
  });

  it("accepts a correctly signed request and reaches durable acceptance", async () => {
    const signature = twilioSign(TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_URL, params);
    const res = await post("/api/webhooks/sms", body, { ...form, "x-twilio-signature": signature });
    expectNoRedirect(res);
    expect(res.status).toBe(500); // no database here: the provider is told to retry
  });
});

describe("running app: Vapi voice webhooks reach their handler without a session", () => {
  const body = JSON.stringify({ message: vapiStatusUpdate("ringing") });
  const json = { "content-type": "application/json" };

  it("rejects a wrong secret in the handler (401), not with a login redirect", async () => {
    const res = await post("/api/webhooks/voice", body, { ...json, "x-vapi-secret": secret() });
    expectNoRedirect(res);
    expect(res.status).toBe(401);
  });

  it("accepts the correct secret and reaches durable acceptance", async () => {
    const res = await post("/api/webhooks/voice", body, {
      ...json,
      "x-vapi-secret": VAPI_WEBHOOK_SECRET,
    });
    expectNoRedirect(res);
    expect(res.status).toBe(500);
  });
});

describe("running app: the jobs endpoint authenticates with its own secret", () => {
  it("rejects a wrong bearer token with 401, not a redirect", async () => {
    const res = await post("/api/internal/jobs", "", { authorization: "Bearer wrong" });
    expectNoRedirect(res);
    expect(res.status).toBe(401);
  });

  it("accepts the right token without a session", async () => {
    const res = await post("/api/internal/jobs", "", { authorization: `Bearer ${JOBS_SECRET}` });
    expectNoRedirect(res);
    expect(res.status).not.toBe(401);
  });
});
