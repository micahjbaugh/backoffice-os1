// File, git and CI-output helpers for the referee. No business rules here.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const PATHS = {
  state: "workflow/state.json",
  blueprint: "workflow/blueprint.json",
  config: "workflow/config.json",
  history: "workflow/history.jsonl",
  status: "workflow/STATUS.md",
  wipDir: "workflow/wip",
};

/** CI passes the default branch's copy so the autopilot branch cannot loosen its own rules. */
export const configPath = () => process.env.AUTOPILOT_CONFIG || PATHS.config;

/** Test hook: a fixed clock. */
export const now = () => process.env.AUTOPILOT_NOW || new Date().toISOString();

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Write via a temp file + rename so a crash never leaves a half-written state file. */
export function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export const writeJson = (path, value) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

export function removeIfExists(path) {
  if (existsSync(path)) unlinkSync(path);
}

export function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function gitOk(...args) {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
}

/** Append-only record of every referee decision (reviews, rejections, exceptions, errors). */
export function appendHistory(entry) {
  mkdirSync(dirname(PATHS.history), { recursive: true });
  appendFileSync(PATHS.history, `${JSON.stringify({ at: now(), ...entry })}\n`);
}

export function readHistory() {
  if (!existsSync(PATHS.history)) return [];
  return readFileSync(PATHS.history, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Emit step outputs for GitHub Actions (and echo them for humans/tests). */
export function output(values) {
  const lines = Object.entries(values).map(([key, value]) => {
    const text = String(value);
    return text.includes("\n")
      ? `${key}<<__AUTOPILOT_EOF__\n${text}\n__AUTOPILOT_EOF__`
      : `${key}=${text}`;
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Replace the values of secret-looking environment variables before anything is logged. */
export function redactSecrets(text) {
  let out = String(text);
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (/SECRET|TOKEN|KEY|PASSWORD|DATABASE_URL/i.test(name))
      out = out.split(value).join(`[${name}]`);
  }
  return out;
}
