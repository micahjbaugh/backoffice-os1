// Required M1 test 7: service-role / database secrets never appear in the browser bundle.
//
// Runs a real production build with recognizable sentinel secrets in the environment, then scans
// every file the browser can download (.next/static) for them.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const appDir = join(import.meta.dirname, "..");
const distDir = ".next-bundle-test";
const distPath = join(appDir, distDir);

const SECRET_SENTINELS = {
  DATABASE_URL:
    "postgresql://sentinel_db_user:SENTINEL_DB_PASSWORD_4c1d@db.sentinel.invalid:5432/postgres",
  SUPABASE_SERVICE_ROLE_KEY: "SENTINEL_SERVICE_ROLE_KEY_9b7e",
};
const SECRET_FRAGMENTS = [
  "SENTINEL_DB_PASSWORD_4c1d",
  "sentinel_db_user",
  "db.sentinel.invalid",
  "SENTINEL_SERVICE_ROLE_KEY_9b7e",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

let staticFiles: string[] = [];
let allFiles: string[] = [];

beforeAll(() => {
  rmSync(distPath, { recursive: true, force: true });
  const result = spawnSync("pnpm exec next build", {
    cwd: appDir,
    shell: true,
    encoding: "utf8",
    env: {
      ...process.env,
      ...SECRET_SENTINELS,
      NEXT_PUBLIC_SUPABASE_URL: "https://public-sentinel.supabase.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "PUBLIC_ANON_KEY_SENTINEL",
      NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  if (result.status !== 0) {
    throw new Error(`next build failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  staticFiles = walk(join(distPath, "static"));
  allFiles = walk(distPath).filter((f) => !f.includes(`${join(distDir, "cache")}`));
});

afterAll(() => {
  rmSync(distPath, { recursive: true, force: true });
});

describe("7. service-role secrets never appear in the browser bundle", () => {
  it("scans real client JavaScript (positive control)", () => {
    const js = staticFiles.filter((f) => f.endsWith(".js"));
    expect(js.length).toBeGreaterThan(0);
    // "Working…" is rendered only by the client-side SubmitButton, so finding it proves the scan
    // covers client component code.
    expect(js.some((f) => readFileSync(f, "utf8").includes("Working…"))).toBe(true);
  });

  it("no browser-downloadable file contains a server secret", () => {
    const leaks = staticFiles.flatMap((file) => {
      const content = readFileSync(file, "latin1");
      return SECRET_FRAGMENTS.filter((s) => content.includes(s)).map((s) => `${file}: ${s}`);
    });
    expect(leaks).toEqual([]);
  });

  it("secrets are not baked into any build artifact (server output reads them at runtime)", () => {
    const leaks = allFiles.flatMap((file) => {
      const content = readFileSync(file, "latin1");
      return SECRET_FRAGMENTS.filter((s) => content.includes(s)).map((s) => `${file}: ${s}`);
    });
    expect(leaks).toEqual([]);
  });

  it("build output exists where expected", () => {
    expect(existsSync(join(distPath, "static"))).toBe(true);
  });
});
