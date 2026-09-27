// Test harness: a throwaway git repo with a minimal plan, driven through the real referee CLI.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "scripts", "autopilot.mjs");
const REPO_ROOT = join(here, "..", "..");
const PRETTIER = createRequire(join(REPO_ROOT, "package.json")).resolve(
  "prettier/bin/prettier.cjs",
);

export const task = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}`,
  done_when: `${id} works`,
  status: "pending",
  ...extra,
});

export function blueprint(milestones) {
  return {
    schema_version: 2,
    schema: { task_statuses: ["pending", "in_progress", "done", "blocked"] },
    milestones: milestones.map((m, mi) => ({
      id: mi + 1,
      key: m.key,
      name: m.name ?? m.key,
      status: "pending",
      acceptance: m.acceptance ?? [`${m.key} works end to end`],
      requires: m.requires,
      acceptance_commands: m.acceptance_commands,
      tasks: m.tasks.map((t, i) => ({ index: i, ...t })),
    })),
  };
}

const GATE = (name) => ({
  name,
  cmd: `node -e "const f=process.env.FAIL_GATE;if(f==='code'){console.log('AssertionError: expected 1 to be 2');process.exit(1)}if(f==='infra'){console.log('npm ERR! network ETIMEDOUT');process.exit(1)}"`,
});

export function testConfig(overrides = {}) {
  return {
    enabled: true,
    builder: { engineer: "claude", model: "test-model", max_turns: 10 },
    reviewer: {
      engineer: "chatgpt",
      provider: "openai",
      model: "test-reviewer",
      max_diff_chars: 60000,
    },
    max_attempts_per_task: 3,
    max_stalled_runs: 3,
    target_changed_lines_per_file: 15,
    max_changed_lines_per_file: 20,
    atomic_hard_limit: 40,
    line_limit_exempt_paths: ["pnpm-lock.yaml"],
    generated_paths: ["**/*.gen.ts"],
    protected_paths: [".github/", "CLAUDE.md"],
    standard_package_scripts: {
      lint: "eslint .",
      typecheck: "tsc -p tsconfig.json",
      test: "vitest run",
    },
    gates: [GATE("lint"), GATE("tests")],
    live_stack_gates: [],
    pause_after_failures: 4,
    pause_after_persistent_failures: 2,
    notify_after_failures: 3,
    pause_at_milestone_boundary: false,
    ...overrides,
  };
}

export class Repo {
  constructor({ plan, config = testConfig(), state = {} }) {
    this.dir = mkdtempSync(join(tmpdir(), "referee-"));
    this.git("init", "-q", "-b", "autopilot");
    this.git("config", "user.email", "t@t");
    this.git("config", "user.name", "t");
    this.git("config", "core.autocrlf", "false");
    this.write("CLAUDE.md", "# Rules\nBe correct.\n");
    this.write(
      "package.json",
      JSON.stringify(
        { name: "fixture", scripts: { test: "vitest run", lint: "eslint ." } },
        null,
        2,
      ),
    );
    this.write(
      "packages/app/package.json",
      JSON.stringify({ name: "app", scripts: { test: "vitest run" } }, null, 2),
    );
    this.write("packages/app/vitest.config.ts", "export default {};\n");
    this.write("packages/app/src/index.ts", "export const one = 1;\n");
    this.write("packages/app/test/index.test.ts", "// test\n");
    this.write("workflow/config.json", JSON.stringify(config, null, 2));
    this.write("workflow/blueprint.json", JSON.stringify(plan, null, 2));
    this.write(
      "workflow/state.json",
      JSON.stringify(
        {
          current_milestone_id: 1,
          current_task_index: 0,
          status: "READY_TO_START",
          last_engineer_used: "NONE",
          handoff_instructions: "start",
          ...state,
        },
        null,
        2,
      ),
    );
    this.commit("base");
    this.gateFile = join(this.dir, "..", `${this.dir.split(/[\\/]/).pop()}-gate.json`);
  }

  git(...args) {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" });
  }
  write(path, content) {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }
  read(path) {
    return readFileSync(join(this.dir, path), "utf8");
  }
  exists(path) {
    return existsSync(join(this.dir, path));
  }
  json(path) {
    return JSON.parse(this.read(path));
  }
  get state() {
    return this.json("workflow/state.json");
  }
  get plan() {
    return this.json("workflow/blueprint.json");
  }
  history() {
    return this.exists("workflow/history.jsonl")
      ? this.read("workflow/history.jsonl")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  }
  head() {
    return this.git("rev-parse", "HEAD").trim();
  }
  commit(message) {
    this.git("add", "-A");
    try {
      this.git("commit", "-q", "-m", message);
    } catch {
      /* nothing to commit */
    }
  }
  tmpFiles() {
    return readdirSync(join(this.dir, "workflow")).filter((f) => f.includes(".tmp-"));
  }

  /** Run a referee command; returns parsed key=value outputs plus exit status. */
  run(command, env = {}, args = []) {
    const result = spawnSync(process.execPath, [CLI, command, ...args], {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: "",
        AUTOPILOT_PRETTIER: PRETTIER,
        AUTOPILOT_CONFIG: "",
        ...env,
      },
    });
    const out = {};
    for (const line of result.stdout.split("\n")) {
      const m = /^([a-z_]+)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
    return { ...out, status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Async variant for commands that call a mock server living in this process (a synchronous spawn
   * would block the event loop and deadlock the server).
   */
  runAsync(command, env = {}, args = []) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, command, ...args], {
        cwd: this.dir,
        env: {
          ...process.env,
          GITHUB_OUTPUT: "",
          AUTOPILOT_PRETTIER: PRETTIER,
          AUTOPILOT_CONFIG: "",
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => {
        const out = {};
        for (const line of stdout.split("\n")) {
          const m = /^([a-z_]+)=(.*)$/.exec(line);
          if (m) out[m[1]] = m[2];
        }
        resolve({ ...out, status, stdout, stderr });
      });
    });
  }

  /** One builder turn exactly as CI does it: step -> gate -> finish-build -> commit. */
  buildTurn(step, { gate = "pass", runGate = true } = {}) {
    const base = this.head();
    step(this);
    const env = {
      BASE_SHA: base,
      GATE_FILE: this.gateFile,
      FAIL_GATE: gate === "pass" ? "" : gate,
    };
    rmSync(this.gateFile, { force: true });
    if (runGate) this.run("gate", env, ["--out", this.gateFile]);
    const result = this.run("finish-build", runGate ? env : { BASE_SHA: base });
    this.commit("step");
    return result;
  }

  /** Builder edits its handoff in state.json. */
  finishStep(status, extra = {}) {
    const s = this.state;
    this.write(
      "workflow/state.json",
      JSON.stringify(
        {
          ...s,
          status,
          last_engineer_used: "claude",
          handoff_instructions: `did work -> ${status}`,
          ...extra,
        },
        null,
        2,
      ),
    );
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.gateFile, { force: true });
  }
}

/** Mock OpenAI chat-completions server; `decide(n, body)` returns a verdict per call. */
export async function mockReviewer(decide) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      calls.push(parsed);
      const verdict = decide(calls.length, parsed);
      res.setHeader("content-type", "application/json");
      if (verdict.httpStatus) {
        res.statusCode = verdict.httpStatus;
        return res.end(JSON.stringify({ error: { message: verdict.message } }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

export const lines = (n, prefix = "x") =>
  Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";
