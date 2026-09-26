#!/usr/bin/env node
// Autopilot referee. Deterministic, dependency-free. The AI engineers never decide whose turn it
// is, never advance the plan themselves, and cannot edit this file (protected path).
//
//   node workflow/scripts/autopilot.mjs status        human-readable summary
//   node workflow/scripts/autopilot.mjs validate      structural checks on workflow files
//   node workflow/scripts/autopilot.mjs next          decide this run's action (build | review | stop)
//   node workflow/scripts/autopilot.mjs finish-build  enforce rules on the builder's step, update state
//   node workflow/scripts/autopilot.mjs review        ChatGPT reviews the task diff, then advance or send back
//   node workflow/scripts/autopilot.mjs pause | resume | resume-mark-done   human controls
//
// Env: BASE_SHA, GATE_OK, GATE_LOG (finish-build); OPENAI_API_KEY (review); GITHUB_OUTPUT (CI).

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const STATE = "workflow/state.json";
const BLUEPRINT = "workflow/blueprint.json";
const CONFIG_IN_REPO = "workflow/config.json";
// CI passes the default branch's copy so the autopilot branch can never loosen its own rules.
const CONFIG = process.env.AUTOPILOT_CONFIG ?? CONFIG_IN_REPO;
const STOP_STATUSES = new Set(["BLOCKED", "NEEDS_HUMAN", "MILESTONE_COMPLETE", "PAUSED"]);
const BUILD_STATUSES = new Set(["READY_TO_START", "IN_PROGRESS", "CHANGES_REQUESTED"]);
const BUILDER_EXIT_STATUSES = new Set(["AWAITING_REVIEW", "IN_PROGRESS", "BLOCKED", "NEEDS_HUMAN"]);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const now = () => new Date().toISOString();

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => {
    const s = String(v);
    return s.includes("\n") ? `${k}<<__AUTOPILOT_EOF__\n${s}\n__AUTOPILOT_EOF__` : `${k}=${s}`;
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

function load() {
  return { state: readJson(STATE), bp: readJson(BLUEPRINT), config: readJson(CONFIG) };
}

function save({ state, bp }) {
  state.updated_at = now();
  writeJson(STATE, state);
  writeJson(BLUEPRINT, bp);
}

function locate(state, bp) {
  const mIndex = bp.milestones.findIndex((m) => m.id === state.current_milestone_id);
  const milestone = bp.milestones[mIndex];
  const task = milestone?.tasks[state.current_task_index];
  return { mIndex, milestone, task };
}

/** Deferred tasks (human work parked for later) are skipped, but stay open until marked done. */
const isSkippable = (task) => task.status === "done" || task.deferred === true;

/** A milestone is done only when every task is done, deferred ones included. */
function refreshMilestoneStatus(milestone) {
  if (milestone.tasks.every((t) => t.status === "done")) milestone.status = "done";
  else if (milestone.status === "pending" || milestone.status === "done") {
    milestone.status = milestone.tasks.some((t) => t.status !== "pending")
      ? "in_progress"
      : "pending";
  }
}

/** Move the pointer past done and deferred tasks. Returns false when nothing is left to build. */
function skipDone(state, bp) {
  for (;;) {
    const { mIndex, milestone, task } = locate(state, bp);
    if (!milestone) return false;
    if (task && !isSkippable(task)) {
      if (milestone.status === "pending") milestone.status = "in_progress";
      return true;
    }
    if (task) {
      state.current_task_index += 1;
      continue;
    }
    refreshMilestoneStatus(milestone);
    const next = bp.milestones[mIndex + 1];
    if (!next) return false;
    state.current_milestone_id = next.id;
    state.current_task_index = 0;
  }
}

function resetTaskFields(state) {
  state.attempts = 0;
  state.review_notes = "";
  state.review_base = null;
}

/** Mark the current task done and move to the next buildable task, pausing at milestone boundaries if configured. */
function advance(ctx, engineer, summary) {
  const { state, bp, config } = ctx;
  const { milestone, task } = locate(state, bp);
  task.status = "done";
  resetTaskFields(state);
  state.last_engineer_used = engineer;
  state.current_task_index += 1;
  const more = skipDone(state, bp);
  const { milestone: nextMilestone, task: nextTask } = locate(state, bp);
  const deferred = bp.milestones
    .flatMap((m) => m.tasks)
    .filter((t) => t.deferred && t.status !== "done");
  const waiting = deferred.length
    ? ` Deferred tasks still waiting for a person: ${deferred.map((t) => t.id).join(", ")}.`
    : "";

  if (!more || !nextTask) {
    state.status = "MILESTONE_COMPLETE";
    state.handoff_instructions = `${summary} ${task.id} is done. No buildable tasks remain.${waiting}`;
    return;
  }
  state.status = "READY_TO_START";
  const crossed = nextMilestone.id !== milestone.id;
  if (crossed && config.pause_at_milestone_boundary) {
    state.status = "MILESTONE_COMPLETE";
    state.handoff_instructions =
      `${summary} ${milestone.key} work is complete. A human must review its acceptance criteria, ` +
      `then run "resume" from the Actions tab to begin ${nextMilestone.key}.${waiting}`;
    return;
  }
  state.handoff_instructions = crossed
    ? `${summary} ${task.id} is done and ${milestone.key} work is complete. Next: ${nextTask.id} "${nextTask.title}".${waiting}`
    : `${summary} ${task.id} is done. Next: ${nextTask.id} "${nextTask.title}".`;
}

/** Record a failed attempt; too many failures on one task stops the autopilot for a human. */
function sendBack(ctx, engineer, notes) {
  const { state, config } = ctx;
  state.attempts = (state.attempts ?? 0) + 1;
  state.last_engineer_used = engineer;
  state.review_notes = notes;
  if (state.attempts >= config.max_attempts_per_task) {
    state.status = "BLOCKED";
    state.handoff_instructions = `Stopped after ${state.attempts} failed attempts. A human must look. Last notes: ${notes}`;
  } else {
    state.status = "CHANGES_REQUESTED";
    state.handoff_instructions = `Attempt ${state.attempts} was sent back. Fix review_notes, then resubmit.`;
  }
}

function validate({ state, bp }) {
  const errors = [];
  const statuses = new Set(bp.schema?.task_statuses ?? []);
  const ids = new Set();
  for (const m of bp.milestones) {
    m.tasks.forEach((t, i) => {
      if (t.index !== i) errors.push(`${t.id}: index ${t.index} != position ${i}`);
      if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
      ids.add(t.id);
      if (!statuses.has(t.status)) errors.push(`${t.id}: bad status ${t.status}`);
    });
  }
  for (const k of [
    "current_milestone_id",
    "current_task_index",
    "status",
    "last_engineer_used",
    "handoff_instructions",
  ]) {
    if (!(k in state)) errors.push(`state.json missing ${k}`);
  }
  if (!locate(state, bp).milestone) errors.push("state points at an unknown milestone");
  return errors;
}

function renderBuilderPrompt({ state, bp, config }) {
  const { milestone, task } = locate(state, bp);
  const lines = [
    `You are the BUILDER (Claude) in the Back Office OS autopilot. ChatGPT reviews your work next.`,
    `Follow CLAUDE.md, especially the "Back-Office Automation Protocol". Read workflow/state.json first.`,
    ``,
    `Current task (${milestone.key}: ${milestone.name}):`,
    JSON.stringify(task, null, 2),
    ``,
    `State status: ${state.status}. Previous handoff: ${state.handoff_instructions}`,
  ];
  if (state.review_notes) lines.push(``, `REVIEW NOTES TO ADDRESS FIRST:`, state.review_notes);
  lines.push(
    ``,
    `Rules for this run:`,
    `- Work ONLY on ${task.id}. Make ONE step: aim for at most ${config.target_changed_lines_per_file} changed lines per file; the hard limit is ${config.max_changed_lines_per_file} (steps over it are discarded). Split bigger work across runs.`,
    `- Run pnpm lint, pnpm typecheck and pnpm test before finishing.`,
    `- Before setting AWAITING_REVIEW, self-review the whole task diff against the reviewer's checklist`,
    `  (ChatGPT sends the task back for any of these): behavior is correct and matches "done_when";`,
    `  multi-tenant isolation holds (organization_id on tenant rows, RLS on new tables, same-org references);`,
    `  authorization is enforced in code, never in prompts; consequential actions write an audit record and`,
    `  business event; external side effects are idempotent; new behavior has tests (including tenant`,
    `  isolation for new tables); no secrets; nothing outside this task was changed.`,
    `- Do NOT git commit or push. Do NOT edit: ${config.protected_paths.join(", ")}. Do NOT edit blueprint.json.`,
    `- Finish by editing workflow/state.json only these fields:`,
    `  status: "AWAITING_REVIEW" (task fully done) | "IN_PROGRESS" (more steps needed) | "NEEDS_HUMAN" or "BLOCKED" (explain why)`,
    `  last_engineer_used: "claude"`,
    `  handoff_instructions: exactly which files/code you changed and exactly what happens next.`,
    `- Keep responses brief; spend tokens on the work, not narration.`,
  );
  return lines.join("\n");
}

// --- commands -----------------------------------------------------------------

function cmdStatus() {
  const ctx = load();
  const { milestone, task } = locate(ctx.state, ctx.bp);
  const done = ctx.bp.milestones.flatMap((m) => m.tasks).filter((t) => t.status === "done").length;
  const total = ctx.bp.milestones.flatMap((m) => m.tasks).length;
  console.log(
    `Autopilot ${ctx.config.enabled ? "ENABLED" : "DISABLED"} · ${done}/${total} tasks done`,
  );
  console.log(
    `Now: ${milestone?.key} ${task?.id ?? "-"} "${task?.title ?? "-"}" · status ${ctx.state.status}`,
  );
  console.log(
    `Attempts: ${ctx.state.attempts ?? 0} · last engineer: ${ctx.state.last_engineer_used}`,
  );
  console.log(`Handoff: ${ctx.state.handoff_instructions}`);
  if (ctx.state.review_notes) console.log(`Review notes: ${ctx.state.review_notes}`);
  if (ctx.state.last_error) console.log(`Last error: ${ctx.state.last_error}`);
}

function cmdValidate() {
  const errors = validate(load());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("workflow files valid");
}

function cmdNext() {
  const ctx = load();
  const { state, bp, config } = ctx;
  const errors = validate(ctx);
  if (errors.length)
    return output({
      action: "stop",
      reason: `invalid workflow files: ${errors[0]}`,
      state_changed: false,
    });
  if (!config.enabled)
    return output({
      action: "stop",
      reason: "autopilot disabled in workflow/config.json",
      state_changed: false,
    });
  if (STOP_STATUSES.has(state.status))
    return output({
      action: "stop",
      reason: `status ${state.status}: waiting for a human`,
      state_changed: false,
    });

  const before = JSON.stringify({ state, bp });
  const startId = locate(state, bp).task?.id;
  if (!skipDone(state, bp)) {
    state.status = "MILESTONE_COMPLETE";
    state.handoff_instructions = "Every task in blueprint.json is done.";
  }
  const { task } = locate(state, bp);
  if (task && task.id !== startId && state.status === "READY_TO_START") {
    state.handoff_instructions = `Skipped tasks already marked done. Start ${task.id} "${task.title}".`;
  }
  if (task && task.requires_human && state.status !== "NEEDS_HUMAN") {
    state.status = "NEEDS_HUMAN";
    state.handoff_instructions =
      `${task.id} "${task.title}" needs a person: ${task.requires_human} ` +
      `When finished: Actions tab -> autopilot -> Run workflow -> "resume-mark-done".`;
  }
  const changed = JSON.stringify({ state, bp }) !== before;
  if (changed) save(ctx);

  const common = { task_id: task?.id ?? "none", state_changed: changed };
  if (STOP_STATUSES.has(state.status))
    return output({ ...common, action: "stop", reason: `status ${state.status}` });
  if (state.status === "AWAITING_REVIEW")
    return output({ ...common, action: "review", reason: "builder step awaiting review" });
  if (BUILD_STATUSES.has(state.status)) {
    return output({
      ...common,
      action: "build",
      reason: `building ${task.id}`,
      builder_model: config.builder.model,
      builder_max_turns: config.builder.max_turns,
      prompt: renderBuilderPrompt(ctx),
    });
  }
  return output({ ...common, action: "stop", reason: `unknown status ${state.status}` });
}

function changedFiles(base) {
  git("add", "-A");
  return git("diff", "--cached", "--numstat", base)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split("\t");
      const path = rest.join("\t");
      return { path, lines: add === "-" ? 0 : Number(add) + Number(del) };
    });
}

function discardWork(base) {
  // Keep the pre-step code; the state update is written afterwards by the caller.
  git("reset", "--hard", base);
  git("clean", "-fd");
}

function cmdFinishBuild() {
  const base = process.env.BASE_SHA;
  if (!base) throw new Error("BASE_SHA is required");
  const config = readJson(CONFIG);
  const files = changedFiles(base);

  // The builder must not change the referee, the CI workflow, or the plan.
  const protectedHits = files.filter(
    (f) => config.protected_paths.some((p) => f.path.startsWith(p)) || f.path === BLUEPRINT,
  );
  let builderState = null;
  try {
    builderState = readJson(STATE);
  } catch {
    builderState = null;
  }

  const overLimit = files.filter(
    (f) =>
      !config.line_limit_exempt_paths.includes(f.path) &&
      f.lines > config.max_changed_lines_per_file,
  );
  const stateTouched = files.some((f) => f.path === STATE);
  const problems = [];
  if (protectedHits.length)
    problems.push(`edited protected files: ${protectedHits.map((f) => f.path).join(", ")}`);
  if (overLimit.length) {
    problems.push(
      `over the ${config.max_changed_lines_per_file}-line-per-file limit: ` +
        overLimit.map((f) => `${f.path} (${f.lines})`).join(", ") +
        ". Split the work into smaller steps.",
    );
  }
  if (!builderState || !stateTouched || !BUILDER_EXIT_STATUSES.has(builderState.status)) {
    problems.push(
      "run ended without a valid workflow/state.json update (likely out of turns). Take a smaller step.",
    );
  }

  // Restore trusted copies of plan/config before applying the referee's decision. State is rebuilt
  // from the pre-step commit so the builder cannot move the pointer or reset attempts itself.
  discardWorkIf(problems.length > 0, base);
  const ctx = {
    state: JSON.parse(git("show", `${base}:${STATE}`)),
    bp: readJson(BLUEPRINT),
    config,
  };
  // Claude completed a run, so any earlier outage is resolved.
  ctx.state.last_error = "";
  ctx.state.consecutive_failures = 0;
  if (problems.length) {
    sendBack(ctx, "claude", `Referee rejected the step and discarded it: ${problems.join(" ")}`);
    save(ctx);
    return output({
      commit: true,
      message: `autopilot: rejected claude step (${ctx.state.status})`,
    });
  }

  // Accept the builder's own state fields, but only the ones it is allowed to set.
  ctx.state.status = builderState.status;
  ctx.state.last_engineer_used = "claude";
  ctx.state.handoff_instructions = String(builderState.handoff_instructions ?? "");
  ctx.state.review_base ??= base;
  const { task } = locate(ctx.state, ctx.bp);
  if (task && task.status === "pending") task.status = "in_progress";

  if (process.env.GATE_OK !== "true" && ctx.state.status === "AWAITING_REVIEW") {
    const log =
      process.env.GATE_LOG && existsSync(process.env.GATE_LOG)
        ? readFileSync(process.env.GATE_LOG, "utf8").slice(-4000)
        : "(no log)";
    sendBack(
      ctx,
      "claude",
      `lint/typecheck/test failed after the step. Fix before resubmitting.\n${log}`,
    );
  }
  save(ctx);
  return output({
    commit: true,
    // Lets CI run ChatGPT's review in the same run instead of waiting for the next one.
    review_now: ctx.state.status === "AWAITING_REVIEW",
    message: `autopilot(${task?.id}): claude step -> ${ctx.state.status}`,
  });
}

function discardWorkIf(condition, base) {
  if (condition) {
    discardWork(base);
    return;
  }
  // Even on success, never let the builder's edits to blueprint/config survive.
  git("checkout", base, "--", BLUEPRINT, CONFIG_IN_REPO);
}

/**
 * The Claude action can flag a run as failed even though Claude finished the step (e.g. it reports
 * a successful result but went over the turn budget). Exit 0 when the builder left a valid, changed
 * state.json handoff, so the normal referee checks (gate, limits, protected files, review) decide.
 */
function cmdCanSalvage() {
  const base = process.env.BASE_SHA;
  let current;
  let before;
  try {
    current = readJson(STATE);
    before = JSON.parse(git("show", `${base}:${STATE}`));
  } catch {
    process.exit(1);
  }
  const changed =
    current.status !== before.status ||
    current.handoff_instructions !== before.handoff_instructions;
  process.exit(changed && BUILDER_EXIT_STATUSES.has(current.status) ? 0 : 1);
}

/** Claude could not finish (auth, usage limit, outage). Record why; no attempt is used up. */
function cmdRecordError() {
  const who = process.argv[3] === "reviewer" ? "reviewer (ChatGPT)" : "builder (Claude)";
  const fromFile =
    process.env.AUTOPILOT_ERROR_FILE && existsSync(process.env.AUTOPILOT_ERROR_FILE)
      ? readFileSync(process.env.AUTOPILOT_ERROR_FILE, "utf8")
      : "";
  const message = String(process.env.ERROR_MESSAGE || fromFile || "unknown error").slice(0, 1000);
  const ctx = load();
  ctx.state.last_error = `${now()} ${who} run failed: ${message}`;
  ctx.state.consecutive_failures = (ctx.state.consecutive_failures ?? 0) + 1;
  save(ctx);
  output({ commit: true, message: `autopilot: ${who} run failed (will retry next run)` });
}

const NOTIFY_FAILURE_THRESHOLD = 3;
const ISSUE_PREFIX = "[autopilot]";

/**
 * Open a GitHub issue (which @mentions the repo owner, so GitHub emails/pushes them) whenever the
 * autopilot needs a person; close it automatically once the autopilot is moving again.
 */
async function cmdNotify() {
  const { state, bp } = load();
  const { milestone, task } = locate(state, bp);
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const owner = process.env.NOTIFY_USER || repo.split("/")[0];
  const actionsUrl = `https://github.com/${repo}/actions/workflows/autopilot.yml`;

  let need = null;
  if (["NEEDS_HUMAN", "BLOCKED", "MILESTONE_COMPLETE"].includes(state.status)) {
    const label = {
      NEEDS_HUMAN: "needs you for a task",
      BLOCKED: "is blocked",
      MILESTONE_COMPLETE: `finished ${milestone?.key}`,
    }[state.status];
    const action = {
      NEEDS_HUMAN: `Do the task, then Run workflow → **resume-mark-done**.`,
      BLOCKED: `Read the notes above, fix or adjust, then Run workflow → **resume**.`,
      MILESTONE_COMPLETE: `Review ${milestone?.key}'s acceptance criteria (merge \`autopilot\` into \`main\` if happy), then Run workflow → **resume**.`,
    }[state.status];
    need = {
      title: `${ISSUE_PREFIX} ${label}: ${task?.id ?? milestone?.key}`,
      body: [
        `@${owner} the autopilot ${label}.`,
        ``,
        `**Task:** ${task?.id} ${task?.title ?? ""}`,
        `**Status:** ${state.status}`,
        ``,
        `**Details:** ${state.handoff_instructions}`,
        state.review_notes ? `\n**Last review notes:** ${state.review_notes}` : "",
        ``,
        `**What to do:** ${action}`,
        ``,
        `Controls: ${actionsUrl}`,
      ].join("\n"),
    };
  } else if ((state.consecutive_failures ?? 0) >= NOTIFY_FAILURE_THRESHOLD) {
    need = {
      title: `${ISSUE_PREFIX} keeps failing: ${state.consecutive_failures} runs in a row`,
      body: [
        `@${owner} the autopilot has failed ${state.consecutive_failures} runs in a row and is retrying each run.`,
        ``,
        `**Last error:** ${state.last_error}`,
        ``,
        `Common fixes: add OpenAI API credits, or refresh the \`CLAUDE_CODE_OAUTH_TOKEN\` / \`OPENAI_API_KEY\` secrets.`,
        `It resumes on its own once runs succeed. Runs: ${actionsUrl}`,
      ].join("\n"),
    };
  }

  const api = async (path, init = {}) => {
    const response = await fetch(
      `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
      },
    );
    if (!response.ok)
      throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  };

  const open = (await api(`/issues?state=open&per_page=100`)).filter(
    (i) => !i.pull_request && i.title.startsWith(ISSUE_PREFIX),
  );
  if (need && open.some((i) => i.title === need.title)) {
    await notifyMilestoneReviews(api, bp, owner, repo);
    return output({ notified: "already-open" });
  }
  for (const issue of open) {
    await api(`/issues/${issue.number}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: need
          ? "Superseded by a newer autopilot notice."
          : "Resolved: the autopilot is running again.",
      }),
    });
    await api(`/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
  if (need) {
    const created = await api(`/issues`, { method: "POST", body: JSON.stringify(need) });
    await notifyMilestoneReviews(api, bp, owner, repo);
    return output({ notified: created.html_url });
  }
  await notifyMilestoneReviews(api, bp, owner, repo);
  return output({ notified: open.length ? "closed" : "none" });
}

const REVIEW_PREFIX = "[autopilot review]";

/**
 * When milestones finish without pausing, ask the owner to review acceptance in parallel.
 * One informational issue per finished milestone; the owner closes it. Never auto-closed.
 */
async function notifyMilestoneReviews(api, bp, owner, repo) {
  const finished = bp.milestones.filter((m) => m.status === "done" && !m.acceptance_verified);
  // Deferred human tasks the autopilot has already moved past (an earlier task is still being built
  // or the milestone moved on) get one "waiting for you" issue each.
  const { state } = load();
  const order = bp.milestones.flatMap((m) => m.tasks.map((t) => t.id));
  const pointer = order.indexOf(locate(state, bp).task?.id ?? "");
  const deferred = bp.milestones
    .flatMap((m) => m.tasks)
    .filter(
      (t) => t.deferred && t.status !== "done" && (pointer === -1 || order.indexOf(t.id) < pointer),
    );
  if (finished.length === 0 && deferred.length === 0) return;
  const existing = (await api(`/issues?state=all&per_page=100`)).map((i) => i.title);
  for (const t of deferred) {
    const title = `${REVIEW_PREFIX} waiting for you: ${t.id} ${t.title}`;
    if (existing.includes(title)) continue;
    await api(`/issues`, {
      method: "POST",
      body: JSON.stringify({
        title,
        body: [
          `@${owner} the autopilot skipped this task so it could keep building. It needs a person.`,
          ``,
          `**${t.id}: ${t.title}**`,
          `${t.description}`,
          ``,
          `**Why it needs you:** ${t.requires_human ?? "Marked as human work."}`,
          `**Done when:** ${t.done_when}`,
          ``,
          `When finished: https://github.com/${repo}/actions/workflows/autopilot.yml → Run workflow → command **mark-task-done**, task id **${t.id}**. Then close this issue.`,
        ].join("\n"),
      }),
    });
  }
  for (const m of finished) {
    const title = `${REVIEW_PREFIX} ${m.key} finished: please review acceptance`;
    if (existing.includes(title)) continue;
    await api(`/issues`, {
      method: "POST",
      body: JSON.stringify({
        title,
        body: [
          `@${owner} the autopilot finished **${m.key}: ${m.name}** and has moved on to the next milestone.`,
          ``,
          `Please check these acceptance criteria when you can:`,
          ...m.acceptance.map((a) => `- [ ] ${a}`),
          ``,
          `Work is on the \`autopilot\` branch: https://github.com/${repo}/compare/main...autopilot`,
          `If something is wrong, Run workflow → **pause**, then tell Claude what to fix. Close this issue when reviewed.`,
        ].join("\n"),
      }),
    });
  }
}

/** Human controls, run from the Actions tab ("Run workflow"). */
function cmdControl(kind) {
  const ctx = load();
  const { state, bp } = ctx;
  const { task } = locate(state, bp);
  if (kind === "pause") {
    state.status = "PAUSED";
    state.handoff_instructions = `Paused by a human at ${task?.id}. Run "resume" to continue.`;
  } else if (kind === "resume-mark-done" && task) {
    // Same path as an approved task, so milestone-boundary pauses still apply.
    advance(ctx, "human", `A human completed ${task.id}.`);
  } else if (kind === "mark-task-done") {
    // Close out any task by id, typically a deferred human task finished later.
    const id = String(process.env.TASK_ID ?? "")
      .trim()
      .toUpperCase();
    const owner = bp.milestones.find((m) => m.tasks.some((t) => t.id === id));
    if (!owner) throw new Error(`unknown task id "${id}" (expected e.g. M2-T17)`);
    if (id === task?.id) {
      advance(ctx, "human", `A human completed ${id}.`);
    } else {
      owner.tasks.find((t) => t.id === id).status = "done";
      refreshMilestoneStatus(owner);
      state.last_engineer_used = "human";
      const current = task ? `${task.id} "${task.title}"` : "the next task";
      state.handoff_instructions = `A human completed ${id}. Continue with ${current}.`;
    }
  } else {
    state.attempts = 0;
    state.status = "READY_TO_START";
    state.last_engineer_used = "human";
    skipDone(state, bp);
    const next = locate(state, bp).task;
    state.handoff_instructions =
      `Resumed by a human at ${next?.id}. ${state.review_notes ? "Address review_notes first." : ""}`.trim();
  }
  save(ctx);
  output({ commit: true, message: `autopilot: human ${kind}` });
}

async function cmdReview() {
  const ctx = load();
  const { state, config } = ctx;
  if (state.status !== "AWAITING_REVIEW")
    return output({ commit: false, message: "nothing to review" });
  const { milestone, task } = locate(state, ctx.bp);

  if (config.reviewer.provider === "none") {
    advance(ctx, "referee", `Auto-approved (reviewer disabled) after passing gates.`);
    save(ctx);
    return output({ commit: true, message: `autopilot(${task.id}): auto-approved` });
  }

  const base = state.review_base ?? "HEAD~1";
  let diff = git(
    "diff",
    base,
    "HEAD",
    "--",
    ".",
    ":(exclude)pnpm-lock.yaml",
    ":(exclude)workflow/state.json",
    // Referee bookkeeping, never builder work (builder edits to it are rejected before review).
    ":(exclude)workflow/blueprint.json",
  );
  if (diff.length > config.reviewer.max_diff_chars) {
    diff = diff.slice(0, config.reviewer.max_diff_chars) + "\n[diff truncated]";
  }
  const rules = readFileSync("CLAUDE.md", "utf8");

  const verdict = await askOpenAI(config.reviewer.model, [
    {
      role: "system",
      content:
        "You are the REVIEWER (ChatGPT) in an autopilot pair with Claude (the builder). " +
        "Review one task's diff against the task and repository rules. Lint, typecheck and tests already passed. " +
        "workflow/state.json and workflow/blueprint.json are maintained by the referee and are excluded from the diff; " +
        "do not request changes to them. " +
        "Block only for real problems: incorrect behavior, broken multi-tenant isolation, missing authorization or audit, " +
        "missing tests for new behavior, secrets exposure, or work outside the task. Do not block on style. " +
        'Reply with JSON only: {"decision":"approve"|"request_changes","notes":"specific, actionable, brief"}',
    },
    {
      role: "user",
      content: [
        `REPOSITORY RULES (CLAUDE.md):\n${rules}`,
        `MILESTONE: ${milestone.key} ${milestone.name}`,
        `TASK:\n${JSON.stringify(task, null, 2)}`,
        `BUILDER HANDOFF:\n${state.handoff_instructions}`,
        `DIFF:\n${diff || "(empty diff)"}`,
      ].join("\n\n"),
    },
  ]);

  state.last_error = "";
  state.consecutive_failures = 0;
  if (verdict.decision === "approve") {
    advance(ctx, "chatgpt", `ChatGPT approved: ${verdict.notes || "no notes"}.`);
  } else {
    sendBack(ctx, "chatgpt", `ChatGPT requested changes: ${verdict.notes}`);
  }
  save(ctx);
  return output({ commit: true, message: `autopilot(${task.id}): chatgpt ${verdict.decision}` });
}

async function askOpenAI(model, messages) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
  });
  if (!response.ok) {
    // Quota/rate limit/outage: fail the run without touching state; the next scheduled run retries.
    throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const body = await response.json();
  const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
  if (parsed.decision !== "approve" && parsed.decision !== "request_changes") {
    throw new Error(
      `reviewer returned an invalid verdict: ${JSON.stringify(parsed).slice(0, 300)}`,
    );
  }
  return { decision: parsed.decision, notes: String(parsed.notes ?? "").slice(0, 4000) };
}

const commands = {
  status: cmdStatus,
  validate: cmdValidate,
  next: cmdNext,
  "finish-build": cmdFinishBuild,
  review: cmdReview,
  pause: () => cmdControl("pause"),
  resume: () => cmdControl("resume"),
  "resume-mark-done": () => cmdControl("resume-mark-done"),
  "mark-task-done": () => cmdControl("mark-task-done"),
  "record-error": cmdRecordError,
  "can-salvage": cmdCanSalvage,
  notify: cmdNotify,
};
const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: autopilot.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
try {
  await command();
} catch (error) {
  // Surface the reason as a GitHub annotation (visible on the run page) instead of a bare exit code.
  // Messages never include secrets: API errors echo the provider's response body, not the key.
  const message = String(error?.message ?? error)
    .replace(/\s+/g, " ")
    .slice(0, 900);
  console.log(`::error title=autopilot ${process.argv[2]} failed::${message}`);
  // Lets CI record the reason in state.json (and count consecutive failures for notifications).
  if (process.env.AUTOPILOT_ERROR_FILE) writeFileSync(process.env.AUTOPILOT_ERROR_FILE, message);
  process.exit(1);
}
