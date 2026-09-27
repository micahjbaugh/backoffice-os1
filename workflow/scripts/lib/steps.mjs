// What a builder step changed, whether it broke a rule, and preserving work that needs another step.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { git, gitOk, PATHS, writeFileAtomic } from "./io.mjs";

/** Stage everything and list per-file changes against `base`. */
export function changedFiles(base) {
  git("add", "-A");
  return git("diff", "--cached", "--numstat", "--no-renames", base)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split("\t");
      const binary = add === "-";
      return {
        path: rest.join("\t"),
        added: binary ? 0 : Number(add),
        deleted: binary ? 0 : Number(del),
        lines: binary ? 0 : Number(add) + Number(del),
        binary,
        isNew: !gitOk("cat-file", "-e", `${base}:${rest.join("\t")}`),
      };
    });
}

const CHECK_SCRIPTS = ["lint", "typecheck", "test", "build", "format", "format:check", "test:tz"];
const isCheckScript = (name) => CHECK_SCRIPTS.includes(name) || name.startsWith("test:");
const PROTECTED_CONFIG_FILES =
  /(^|\/)(vitest\.config\.(ts|mjs|js)|eslint\.config\.(mjs|js|ts)|tsconfig\.json)$/;

function scriptsOf(ref, path) {
  try {
    const text = ref === ":index" ? git("show", `:${path}`) : git("show", `${ref}:${path}`);
    return JSON.parse(text).scripts ?? {};
  } catch {
    return null;
  }
}

/**
 * Rules the builder may never break (the automation guards its own gates):
 *  - anything under workflow/ except workflow/state.json, and the configured protected paths
 *  - existing test/lint/type configs (new packages may add their own)
 *  - the check scripts (lint/typecheck/test/build/format/test:*) in any existing package.json; a new
 *    package.json may only use the standard ones
 */
export function protectedViolations(files, config, base) {
  const violations = [];
  for (const f of files) {
    const p = f.path;
    if (p.startsWith("workflow/") && p !== PATHS.state) violations.push(`${p} (automation file)`);
    else if (config.protected_paths.some((prefix) => p === prefix || p.startsWith(prefix)))
      violations.push(`${p} (protected)`);
    else if (!f.isNew && PROTECTED_CONFIG_FILES.test(p))
      violations.push(`${p} (existing check configuration)`);
    else if (p.endsWith("package.json")) {
      const before = f.isNew ? null : scriptsOf(base, p);
      const after = scriptsOf(":index", p) ?? {};
      if (before) {
        for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (isCheckScript(name) && before[name] !== after[name])
            violations.push(`${p} (changes check script "${name}")`);
        }
      } else {
        for (const [name, cmd] of Object.entries(after)) {
          if (isCheckScript(name) && config.standard_package_scripts?.[name] !== cmd) {
            violations.push(`${p} (new package uses non-standard "${name}" script)`);
          }
        }
      }
    }
  }
  return violations;
}

function prettierFormat(path, content) {
  const bin =
    process.env.AUTOPILOT_PRETTIER ??
    createRequire(join(process.cwd(), "package.json")).resolve("prettier/bin/prettier.cjs");
  return execFileSync(process.execPath, [bin, "--stdin-filepath", path], {
    input: content,
    encoding: "utf8",
  });
}

const globToRegex = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/?/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, "(.*/)?")}$`,
  );

/**
 * Per-file line limits. Over the hard limit is allowed only with an explicit, verifiable exception
 * declared by the builder in state.json `line_limit_exceptions`:
 *   formatting  the new content must equal Prettier's output for the old content (purely mechanical)
 *   generated   the path must match config.generated_paths
 *   atomic      a written reason, and at most config.atomic_hard_limit lines; flagged to the reviewer
 * Lockfiles and automation state are exempt.
 */
export function checkLimits(files, declared, config, base) {
  const exempt = new Set(config.line_limit_exempt_paths ?? []);
  const generated = (config.generated_paths ?? []).map(globToRegex);
  const overLimit = [];
  const used = [];
  const invalid = [];
  for (const f of files) {
    if (
      exempt.has(f.path) ||
      f.path.startsWith("workflow/") ||
      f.lines <= config.max_changed_lines_per_file
    )
      continue;
    const ex = (declared ?? []).find((e) => e && e.path === f.path);
    if (!ex) {
      overLimit.push(`${f.path} (${f.lines})`);
      continue;
    }
    if (ex.kind === "generated" && generated.some((re) => re.test(f.path))) {
      used.push({ ...ex, lines: f.lines });
    } else if (ex.kind === "formatting") {
      let ok = false;
      try {
        const before = git("show", `${base}:${f.path}`);
        ok = prettierFormat(f.path, before) === git("show", `:${f.path}`);
      } catch {
        ok = false;
      }
      if (ok) used.push({ ...ex, lines: f.lines, verified: "prettier" });
      else
        invalid.push(
          `${f.path}: declared formatting-only, but the change is not exactly Prettier's output`,
        );
    } else if (
      ex.kind === "atomic" &&
      typeof ex.reason === "string" &&
      ex.reason.trim().length >= 20
    ) {
      if (f.lines <= config.atomic_hard_limit) used.push({ ...ex, lines: f.lines });
      else
        invalid.push(
          `${f.path}: ${f.lines} lines exceeds even the atomic limit (${config.atomic_hard_limit})`,
        );
    } else {
      invalid.push(
        `${f.path}: exception "${ex.kind}" is not valid here${ex.kind === "atomic" ? " (needs a reason of 20+ characters)" : ""}`,
      );
    }
  }
  return { overLimit, used, invalid };
}

/**
 * Capture the step's code changes (everything outside workflow/) as a patch the next builder run can
 * re-apply in smaller pieces, instead of discarding useful work. Capture BEFORE resetting and write
 * AFTER: a tracked older patch at the same path would otherwise be restored by the reset.
 */
export function captureWipPatch(taskId, base) {
  const content = git("diff", "--cached", "--binary", base, "--", ".", ":(exclude)workflow/");
  return content.trim() ? { path: `${PATHS.wipDir}/${taskId}.patch`, content } : null;
}

export function writeWipPatch(wip) {
  if (!wip) return null;
  writeFileAtomic(wip.path, wip.content);
  return wip.path;
}

/** Discard the step's working-tree changes, keeping only files under workflow/ that we rewrite after. */
export function resetTo(base) {
  git("reset", "-q", "--hard", base);
  git("clean", "-fdq", "-e", "workflow/wip/");
}

/**
 * Fingerprint of the code (everything outside workflow/) in the index or a commit. Validation and
 * review both record it, so an approval is provably about the exact code that passed the checks.
 */
export function codeFingerprint(ref = ":index") {
  const listing =
    ref === ":index"
      ? git("ls-files", "-s")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [meta, path] = l.split("\t");
            return `${path} ${meta.split(" ")[1]}`;
          })
      : git("ls-tree", "-r", ref)
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [meta, path] = l.split("\t");
            return `${path} ${meta.split(" ")[2]}`;
          });
  const code = listing.filter((l) => !l.startsWith("workflow/")).sort();
  return createHash("sha256").update(code.join("\n")).digest("hex");
}

const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /^(packages|apps)\/[^/]+\/src\/.+\.[cm]?[jt]sx?$/;

/**
 * Does a task's cumulative change touch application source without touching any test?
 * `head` null compares the staged index (a step not yet committed).
 */
export function sourceWithoutTests(base, head = "HEAD") {
  const args =
    head === null
      ? ["diff", "--cached", "--name-only", "--no-renames", base]
      : ["diff", "--name-only", "--no-renames", base, head];
  const paths = git(...args)
    .split("\n")
    .filter(Boolean);
  const source = paths.filter((p) => SOURCE_FILE.test(p) && !TEST_FILE.test(p));
  const tests = paths.filter((p) => TEST_FILE.test(p));
  return source.length > 0 && tests.length === 0 ? source : [];
}
