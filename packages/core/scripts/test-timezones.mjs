#!/usr/bin/env node
// Run the date-sensitive suites under several process timezones. TZ must be set before the Node
// process starts (and some shells, e.g. Git Bash on Windows, do not pass TZ through), so each zone
// runs in its own child process with TZ set here.
import { spawnSync } from "node:child_process";

const ZONES = ["UTC", "America/Chicago", "Asia/Tokyo"];
const FILES = ["test/dates.test.ts", "test/draft-records.test.ts"];

let failed = 0;
for (const zone of ZONES) {
  console.log(`\n=== TZ=${zone}`);
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...FILES], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, TZ: zone },
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED in TZ=${zone}`);
  }
}
if (failed) {
  console.error(`\n${failed} timezone run(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${ZONES.length} timezone runs passed.`);
