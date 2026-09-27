// Deterministic tests for the autopilot referee: task selection, step judging (limits, exceptions,
// protected files, unfinished runs), gates, review (parts, oversize, stale validation), deferred
// acceptance, retries/pauses, atomic state, and the status report.
// Run: node --test workflow/test/

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { blueprint, lines, mockReviewer, Repo, task, testConfig } from "./harness.mjs";

const repos = [];
const repo = (opts) => {
  const r = new Repo(opts);
  repos.push(r);
  return r;
};
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const onePlan = (extra = {}) =>
  blueprint([{ key: "M1", tasks: [task("M1-T00", extra), task("M1-T01")] }]);
const editSource = (r, n = 5, name = "feature") => {
  r.write(`packages/app/src/${name}.ts`, lines(n, name));
  r.write(`packages/app/test/${name}.test.ts`, "// covers it\n");
};

describe("task selection", () => {
  it("honors dependencies, skips deferred tasks, and points at the first buildable task", () => {
    const r = repo({
      plan: blueprint([
        {
          key: "M1",
          tasks: [
            task("M1-T00", { deferred: true, requires_human: "live call" }),
            task("M1-T01", { depends_on: ["M1-T02"] }),
            task("M1-T02"),
          ],
        },
      ]),
    });
    const next = r.run("next");
    assert.equal(next.action, "build");
    assert.equal(next.task_id, "M1-T02");
  });

  it("blocks a milestone until its prerequisite passed automated acceptance", () => {
    const plan = blueprint([
      {
        key: "M1",
        tasks: [task("M1-T00", { status: "done" }), task("M1-T01", { kind: "acceptance" })],
      },
      { key: "M2", requires: [{ milestone: "M1", level: "automated" }], tasks: [task("M2-T00")] },
    ]);
    const r = repo({ plan, state: { current_task_id: "M1-T01" } });
    assert.equal(r.run("next").task_id, "M1-T01");

    // Mark M1's acceptance task done without the automated-acceptance record: M2 must stay blocked.
    const p = r.plan;
    p.milestones[0].tasks[1].status = "done";
    r.write("workflow/blueprint.json", JSON.stringify(p));
    r.write(
      "workflow/state.json",
      JSON.stringify({ ...r.state, current_task_id: "M1-T01", status: "READY_TO_START" }),
    );
    r.commit("fake done");
    const blocked = r.run("next");
    assert.equal(blocked.action, "stop");
    assert.equal(r.state.status, "NEEDS_HUMAN");
    assert.match(
      r.state.handoff_instructions,
      /M2 is blocked: M1 must be code-complete with its automated acceptance suite passing/,
    );
  });

  it("stops on a non-deferred human task with instructions", () => {
    const r = repo({
      plan: blueprint([
        {
          key: "M1",
          tasks: [task("M1-T00", { requires_human: "Needs QuickBooks sandbox credentials." })],
        },
      ]),
    });
    assert.equal(r.run("next").action, "stop");
    assert.equal(r.state.status, "NEEDS_HUMAN");
    assert.match(r.state.handoff_instructions, /QuickBooks sandbox/);
  });

  it("is disabled when config says so", () => {
    const r = repo({ plan: onePlan(), config: testConfig({ enabled: false }) });
    assert.match(r.run("next").reason, /disabled/);
  });
});

describe("step judging", () => {
  it("a valid step with passing checks is recorded as validated and ready for review", () => {
    const r = repo({ plan: onePlan() });
    r.run("next");
    r.commit("select");
    const out = r.buildTurn((x) => {
      editSource(x);
      x.finishStep("AWAITING_REVIEW");
    });
    assert.equal(out.review_now, "true");
    const s = r.state;
    assert.equal(s.status, "AWAITING_REVIEW");
    assert.equal(s.last_validation.passed, true);
    assert.equal(s.attempts, 0);
    assert.equal(r.run("next").action, "review");
  });

  it("failed checks (code) send a finished task back and keep the code", () => {
    const r = repo({ plan: onePlan() });
    const out = r.buildTurn(
      (x) => {
        editSource(x);
        x.finishStep("AWAITING_REVIEW");
      },
      { gate: "code" },
    );
    assert.equal(out.review_now, "false");
    assert.equal(r.state.status, "CHANGES_REQUESTED");
    assert.equal(r.state.attempts, 1);
    assert.match(r.state.review_notes, /AssertionError/);
    assert.ok(r.exists("packages/app/src/feature.ts"), "code is kept for the fix");
  });

  it("infrastructure failures do not cost an attempt; the next run re-validates instead of reviewing", () => {
    const r = repo({ plan: onePlan() });
    r.buildTurn(
      (x) => {
        editSource(x);
        x.finishStep("AWAITING_REVIEW");
      },
      { gate: "infra" },
    );
    const s = r.state;
    assert.equal(s.status, "AWAITING_REVIEW");
    assert.equal(s.attempts, 0);
    assert.equal(s.consecutive_failures, 1);
    assert.equal(s.last_validation.infra, true);
    assert.equal(r.run("next").action, "validate");
  });

  it("over-limit work is preserved as a patch (not discarded) and re-offered to the builder", () => {
    const r = repo({ plan: onePlan() });
    r.buildTurn((x) => {
      editSource(x, 30, "big");
      x.finishStep("AWAITING_REVIEW");
    });
    const s = r.state;
    assert.equal(s.status, "CHANGES_REQUESTED");
    assert.match(s.review_notes, /over the 20-line hard limit.*big\.ts/);
    assert.equal(r.exists("packages/app/src/big.ts"), false, "oversized code is not committed");
    assert.ok(r.exists(s.wip_patch), "but it is saved");
    assert.match(r.read(s.wip_patch), /export const big29/);
    assert.match(
      r.run("next").prompt ?? r.run("next").stdout,
      /saved in workflow\/wip\/M1-T00\.patch/,
    );

    // The next valid step removes the patch.
    r.buildTurn((x) => {
      editSource(x, 10, "small");
      x.finishStep("AWAITING_REVIEW");
    });
    assert.equal(r.exists("workflow/wip/M1-T00.patch"), false);
    assert.equal(r.state.wip_patch, null);
  });

  it("an atomic exception with a reason is accepted and recorded; without a reason it is not", () => {
    const r = repo({ plan: onePlan() });
    r.buildTurn((x) => {
      editSource(x, 30, "atom");
      x.finishStep("AWAITING_REVIEW", {
        line_limit_exceptions: [
          {
            path: "packages/app/src/atom.ts",
            kind: "atomic",
            reason: "migration and its policies must land together",
          },
        ],
      });
    });
    assert.equal(r.state.status, "AWAITING_REVIEW");
    assert.ok(
      r
        .history()
        .some((h) => h.kind === "line_limit_exception" && h.path === "packages/app/src/atom.ts"),
    );

    const r2 = repo({ plan: onePlan() });
    r2.buildTurn((x) => {
      editSource(x, 30, "atom");
      x.finishStep("AWAITING_REVIEW", {
        line_limit_exceptions: [
          { path: "packages/app/src/atom.ts", kind: "atomic", reason: "big" },
        ],
      });
    });
    assert.equal(r2.state.status, "CHANGES_REQUESTED");
    assert.match(r2.state.review_notes, /needs a reason/);
  });

  it("a formatting exception is verified against Prettier, not trusted", () => {
    const messy =
      Array.from({ length: 12 }, (_, i) => `export const   v${i}={a:1,b:[1,2,3],c:"x"}`).join(
        "\n",
      ) + "\n";
    const r = repo({ plan: onePlan({ tests_optional: true }) });
    r.write("packages/app/src/messy.ts", messy);
    r.commit("messy file");
    const formatted = messy.replace(
      /export const {3}v(\d+)=\{a:1,b:\[1,2,3\],c:"x"\}/g,
      'export const v$1 = { a: 1, b: [1, 2, 3], c: "x" };',
    );
    r.buildTurn((x) => {
      x.write("packages/app/src/messy.ts", formatted);
      x.finishStep("AWAITING_REVIEW", {
        line_limit_exceptions: [{ path: "packages/app/src/messy.ts", kind: "formatting" }],
      });
    });
    assert.equal(r.state.status, "AWAITING_REVIEW", r.state.review_notes);

    const r2 = repo({ plan: onePlan({ tests_optional: true }) });
    r2.write("packages/app/src/messy.ts", messy);
    r2.commit("messy file");
    r2.buildTurn((x) => {
      x.write("packages/app/src/messy.ts", formatted.replace("a: 1", "a: 999"));
      x.finishStep("AWAITING_REVIEW", {
        line_limit_exceptions: [{ path: "packages/app/src/messy.ts", kind: "formatting" }],
      });
    });
    assert.equal(r2.state.status, "CHANGES_REQUESTED");
    assert.match(r2.state.review_notes, /not exactly Prettier's output/);
  });

  for (const [name, change] of [
    [
      "the referee config",
      (x) =>
        x.write(
          "workflow/config.json",
          JSON.stringify(testConfig({ max_changed_lines_per_file: 9999 })),
        ),
    ],
    ["CLAUDE.md", (x) => x.write("CLAUDE.md", "# Rules\nAnything goes.\n")],
    [
      "a package test script",
      (x) =>
        x.write(
          "packages/app/package.json",
          JSON.stringify({ name: "app", scripts: { test: "echo ok" } }),
        ),
    ],
    [
      "an existing vitest config",
      (x) =>
        x.write("packages/app/vitest.config.ts", "export default { test: { include: [] } };\n"),
    ],
    [
      "a new package with a non-standard test script",
      (x) =>
        x.write(
          "packages/new/package.json",
          JSON.stringify({ name: "new", scripts: { test: "exit 0" } }),
        ),
    ],
    ["the plan", (x) => x.write("workflow/blueprint.json", JSON.stringify({ milestones: [] }))],
  ]) {
    it(`discards a step that changes ${name}`, () => {
      const r = repo({ plan: onePlan() });
      const before = r.read("packages/app/package.json");
      r.buildTurn((x) => {
        editSource(x);
        change(x);
        x.finishStep("AWAITING_REVIEW");
      });
      assert.equal(r.state.status, "CHANGES_REQUESTED");
      assert.match(r.state.review_notes, /may not change/);
      assert.equal(r.exists("packages/app/src/feature.ts"), false);
      assert.equal(r.read("packages/app/package.json"), before);
      assert.equal(r.json("workflow/config.json").max_changed_lines_per_file, 20);
    });
  }

  it("an interrupted run keeps its work, costs no attempt, and blocks only after repeated stalls", () => {
    const r = repo({ plan: onePlan() });
    for (let i = 1; i <= 3; i += 1) {
      r.buildTurn((x) => editSource(x, 5, `partial${i}`), { runGate: false }); // no state update
      const s = r.state;
      assert.equal(s.attempts, 0);
      assert.equal(s.stalled_runs, i);
      if (i < 3) {
        assert.ok(["READY_TO_START", "IN_PROGRESS"].includes(s.status));
        assert.ok(r.exists(s.wip_patch));
        assert.match(r.read(s.wip_patch), new RegExp(`partial${i}`));
      }
    }
    assert.equal(r.state.status, "BLOCKED");
    assert.match(r.state.handoff_instructions, /split the task/);
  });

  it("a run that produced nothing counts as a failed run, not an attempt", () => {
    const r = repo({ plan: onePlan() });
    r.buildTurn(() => {}, { runGate: false });
    assert.equal(r.state.attempts, 0);
    assert.equal(r.state.consecutive_failures, 1);
  });

  it("a finished task that changes source without tests is sent back", () => {
    const r = repo({ plan: onePlan() });
    r.buildTurn((x) => {
      x.write("packages/app/src/untested.ts", lines(5, "u"));
      x.finishStep("AWAITING_REVIEW");
    });
    assert.equal(r.state.status, "CHANGES_REQUESTED");
    assert.match(r.state.review_notes, /without adding or updating tests/);
  });
});

describe("review", () => {
  const readyForReview = (config, files) => {
    const r = repo({ plan: onePlan(), config });
    r.buildTurn((x) => {
      for (const [path, content] of Object.entries(files)) x.write(path, content);
      x.write("packages/app/test/feature.test.ts", "// covers it\n");
      x.finishStep("AWAITING_REVIEW");
    });
    assert.equal(r.state.status, "AWAITING_REVIEW", r.state.review_notes);
    return r;
  };
  const approve = () => ({
    decision: "approve",
    notes: "ok",
    verified: ["behavior"],
    concerns: [],
  });

  it("reviews every part of a large diff; all must approve; each part is recorded", async () => {
    const r = readyForReview(
      testConfig({ reviewer: { provider: "openai", model: "m", max_diff_chars: 700 } }),
      {
        "packages/app/src/a.ts": lines(15, "a"),
        "packages/app/src/b.ts": lines(15, "b"),
        "packages/app/src/c.ts": lines(15, "c"),
      },
    );
    const mock = await mockReviewer(approve);
    try {
      await r.runAsync("review", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: mock.url });
    } finally {
      await mock.close();
    }
    assert.ok(mock.calls.length >= 2, `expected several parts, got ${mock.calls.length}`);
    const t = r.plan.milestones[0].tasks[0];
    assert.equal(t.status, "done");
    assert.equal(t.verification.level, "reviewed_and_validated");
    assert.equal(t.verification.review_parts, mock.calls.length);
    assert.equal(r.history().filter((h) => h.kind === "review_part").length, mock.calls.length);
    const prompt = mock.calls[0].messages[1].content;
    assert.match(prompt, /<untrusted source="diff part 1\//);
    assert.match(prompt, /CHECK RESULTS/);
    assert.match(prompt, /M1-T00 works/);
  });

  it("one part requesting changes sends the task back", async () => {
    const r = readyForReview(
      testConfig({ reviewer: { provider: "openai", model: "m", max_diff_chars: 700 } }),
      {
        "packages/app/src/a.ts": lines(15, "a"),
        "packages/app/src/b.ts": lines(15, "b"),
      },
    );
    const mock = await mockReviewer((n) =>
      n === 2 ? { decision: "request_changes", notes: "b.ts is wrong" } : approve(),
    );
    try {
      await r.runAsync("review", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: mock.url });
    } finally {
      await mock.close();
    }
    assert.equal(r.state.status, "CHANGES_REQUESTED");
    assert.match(r.state.review_notes, /b\.ts is wrong/);
    assert.equal(r.plan.milestones[0].tasks[0].status, "in_progress");
  });

  it("a file too large for one review part goes to a person; nothing is sent to the model", async () => {
    const r = readyForReview(
      testConfig({ reviewer: { provider: "openai", model: "m", max_diff_chars: 300 } }),
      { "packages/app/src/a.ts": lines(15, "a") },
    );
    const mock = await mockReviewer(approve);
    try {
      await r.runAsync("review", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: mock.url });
    } finally {
      await mock.close();
    }
    assert.equal(mock.calls.length, 0);
    assert.equal(r.state.status, "NEEDS_HUMAN");
    assert.match(r.state.handoff_instructions, /too large for automated review/);
  });

  it("refuses to review code that changed after it was validated", async () => {
    const r = readyForReview(testConfig(), { "packages/app/src/a.ts": lines(5, "a") });
    r.write("packages/app/src/a.ts", lines(6, "a"));
    r.commit("sneaky change after validation");
    const mock = await mockReviewer(approve);
    try {
      const out = await r.runAsync("review", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: mock.url });
      assert.match(out.message, /not passed the checks in its current form/);
    } finally {
      await mock.close();
    }
    assert.equal(mock.calls.length, 0);
    assert.equal(r.plan.milestones[0].tasks[0].status, "in_progress");
    assert.equal(r.run("next").action, "validate");
  });
});

describe("milestones and deferred human checks", () => {
  it("a milestone with a pending human check is code-complete, never accepted", async () => {
    const plan = blueprint([
      {
        key: "M1",
        tasks: [
          task("M1-T00", { status: "done" }),
          task("M1-T01", { deferred: true, requires_human: "real phone call" }),
          task("M1-T02", { kind: "acceptance" }),
        ],
      },
    ]);
    const r = repo({ plan, state: { current_task_id: "M1-T02" } });
    r.buildTurn((x) => {
      editSource(x, 5, "accept");
      x.finishStep("AWAITING_REVIEW");
    });
    const mock = await mockReviewer(() => ({ decision: "approve", notes: "ok" }));
    try {
      await r.runAsync("review", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: mock.url });
    } finally {
      await mock.close();
    }
    const m = r.plan.milestones[0];
    assert.equal(m.tasks[2].verification.level, "acceptance_suite");
    assert.ok(m.automated_acceptance.passed_at);
    assert.equal(m.status, "code_complete");
    assert.equal(r.state.status, "NEEDS_HUMAN");

    r.run("mark-task-done", { TASK_ID: "M1-T01" });
    assert.equal(r.plan.milestones[0].status, "accepted");
  });
});

describe("failures, pauses and recovery", () => {
  it("transient failures pause after the configured count; resume restores the previous state", () => {
    const r = repo({ plan: onePlan(), state: { status: "AWAITING_REVIEW" } });
    for (let i = 0; i < 4; i += 1)
      r.run("record-error", { ERROR_MESSAGE: "OpenAI API 503: overloaded" }, ["reviewer"]);
    assert.equal(r.state.status, "PAUSED");
    assert.match(r.state.pause_reason, /4 failed runs in a row/);
    r.run("resume");
    assert.equal(r.state.status, "AWAITING_REVIEW");
    assert.equal(r.state.consecutive_failures, 0);
  });

  it("errors that will not fix themselves pause sooner, with an actionable reason, and secrets are redacted", () => {
    const r = repo({ plan: onePlan() });
    const env = {
      OPENAI_API_KEY: "sk-live-very-secret-value",
      ERROR_MESSAGE: "OpenAI API 401: invalid api key sk-live-very-secret-value",
    };
    r.run("record-error", env, ["reviewer"]);
    r.run("record-error", env, ["reviewer"]);
    assert.equal(r.state.status, "PAUSED");
    assert.match(r.state.pause_reason, /will not fix itself/);
    assert.doesNotMatch(
      r.read("workflow/state.json") + r.read("workflow/history.jsonl"),
      /sk-live-very-secret-value/,
    );
  });

  it("state writes are atomic (no temp files left behind) and the status report is honest", () => {
    const r = repo({ plan: onePlan() });
    r.run("next");
    r.run("report");
    assert.deepEqual(r.tmpFiles(), []);
    const report = r.read("workflow/STATUS.md");
    assert.match(report, /code_complete \(all non-deferred tasks accepted\)/);
    assert.doesNotMatch(report, /\d+%/);
  });
});
