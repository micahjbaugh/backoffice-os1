// Deterministic checks. The referee runs them itself; no model can approve past a failed check.
//
// Each failure is classified:
//   code   the change is wrong (lint/type/test failure) -> the builder must fix it
//   infra  the environment failed (registry/network, out of memory, Docker unavailable) -> retry the
//          run later without charging the builder an attempt; bounded by the failure counters.

import { spawnSync } from "node:child_process";
import { redactSecrets } from "./io.mjs";

const INFRA_PATTERNS = [
  /ENOMEM|JavaScript heap out of memory|Fatal process out of memory/i,
  /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up/i,
  /ERR_PNPM_(FETCH|META_FETCH|TARBALL)|registry\.npmjs\.org.*(5\d\d|timeout)/i,
  /Cannot connect to the Docker daemon|docker: .*error during connect/i,
  /No space left on device/i,
];

export function classifyFailure(exitCode, output) {
  if (exitCode === 137 || exitCode === 134) return "infra"; // killed (OOM) / aborted
  return INFRA_PATTERNS.some((re) => re.test(output)) ? "infra" : "code";
}

/** Checks for this run: the standard gate, plus the milestone acceptance suite for acceptance tasks. */
export function gatePlan(config, task, milestone) {
  const checks = [...config.gates];
  if (task?.kind === "acceptance") {
    for (const cmd of milestone?.acceptance_commands ?? [])
      checks.push({ name: `acceptance: ${cmd}`, cmd });
    if (milestone?.acceptance_live_stack) checks.push(...(config.live_stack_gates ?? []));
  }
  for (const cmd of task?.verify_commands ?? []) checks.push({ name: `task: ${cmd}`, cmd });
  return checks;
}

export function runGate(checks, { run = defaultRun } = {}) {
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    const { status, output } = run(check.cmd);
    const passed = status === 0;
    results.push({
      name: check.name,
      cmd: check.cmd,
      passed,
      classification: passed ? null : classifyFailure(status, output),
      seconds: Math.round((Date.now() - started) / 1000),
      tail: passed ? "" : redactSecrets(output.split("\n").slice(-60).join("\n")),
    });
    if (!passed && !check.continue_on_failure) break;
  }
  const failed = results.filter((r) => !r.passed);
  return {
    passed: failed.length === 0 && results.length === checks.length,
    infra: failed.some((r) => r.classification === "infra"),
    results,
  };
}

function defaultRun(cmd) {
  const result = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

export function summarizeGate(gate) {
  return gate.results
    .map((r) => `${r.passed ? "PASS" : `FAIL(${r.classification})`} ${r.name}`)
    .join("; ");
}
