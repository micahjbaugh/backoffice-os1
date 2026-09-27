// Blueprint navigation: which task is next, and what each milestone has actually achieved.
//
// Milestone levels (never inferred from task counts alone):
//   pending        nothing started
//   in_progress    some work done
//   code_complete  every non-deferred task accepted; deferred human checks may still be open
//   accepted       every task accepted, including human checks and the automated acceptance task
// A milestone's `automated_acceptance` records when its acceptance task (kind "acceptance") passed:
// the automated end-to-end suite against realistic fixtures (and the local Supabase stack).

export const STOP_STATUSES = new Set(["BLOCKED", "NEEDS_HUMAN", "PAUSED", "MILESTONE_COMPLETE"]);
export const BUILD_STATUSES = new Set(["READY_TO_START", "IN_PROGRESS", "CHANGES_REQUESTED"]);
export const BUILDER_EXIT_STATUSES = new Set([
  "AWAITING_REVIEW",
  "IN_PROGRESS",
  "BLOCKED",
  "NEEDS_HUMAN",
]);
export const TASK_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);

export const allTasks = (bp) =>
  bp.milestones.flatMap((m) => m.tasks.map((t) => ({ milestone: m, task: t })));

export function findTask(bp, id) {
  return allTasks(bp).find((x) => x.task.id === id) ?? null;
}

export function currentTask(state, bp) {
  if (state.current_task_id) return findTask(bp, state.current_task_id);
  const milestone = bp.milestones.find((m) => m.id === state.current_milestone_id);
  const task = milestone?.tasks[state.current_task_index];
  return milestone && task ? { milestone, task } : null;
}

/** Point the legacy fields (milestone id + index) and the id at a task. */
export function pointAt(state, found) {
  state.current_task_id = found.task.id;
  state.current_milestone_id = found.milestone.id;
  state.current_task_index = found.task.index;
}

function requirementMet(bp, req) {
  const m = bp.milestones.find((x) => x.key === req.milestone);
  if (!m) return { ok: false, reason: `required milestone ${req.milestone} does not exist` };
  if (req.level === "accepted") {
    return m.status === "accepted"
      ? { ok: true }
      : { ok: false, reason: `${m.key} must be fully accepted first` };
  }
  // "automated": code complete and the automated acceptance suite passed (human checks may be pending).
  const code = m.status === "code_complete" || m.status === "accepted";
  if (code && m.automated_acceptance?.passed_at) return { ok: true };
  return {
    ok: false,
    reason: `${m.key} must be code-complete with its automated acceptance suite passing first`,
  };
}

export function milestoneBlockers(bp, milestone) {
  return (milestone.requires ?? [])
    .map((r) => requirementMet(bp, r))
    .filter((r) => !r.ok)
    .map((r) => r.reason);
}

const depsDone = (bp, task) =>
  (task.depends_on ?? []).every((id) => findTask(bp, id)?.task.status === "done");

/**
 * The first task that can be built now: not done, not deferred, dependencies done, and its
 * milestone's prerequisites met. Returns { found } or { none: reason }.
 */
export function selectNextTask(bp) {
  const waiting = [];
  for (const milestone of bp.milestones) {
    const open = milestone.tasks.filter((t) => t.status !== "done");
    if (open.length === 0) continue;
    const blockers = milestoneBlockers(bp, milestone);
    if (blockers.length) {
      return { none: `${milestone.key} is blocked: ${blockers.join("; ")}`, waiting };
    }
    for (const task of open) {
      if (task.deferred) {
        waiting.push(`${task.id} (deferred: needs a person)`);
        continue;
      }
      if (!depsDone(bp, task)) {
        waiting.push(`${task.id} (waiting on ${(task.depends_on ?? []).join(", ")})`);
        continue;
      }
      return { found: { milestone, task } };
    }
  }
  return {
    none: waiting.length
      ? `nothing buildable; waiting: ${waiting.join("; ")}`
      : "every task is done",
    waiting,
  };
}

export function refreshMilestoneStatuses(bp) {
  for (const m of bp.milestones) {
    const done = m.tasks.filter((t) => t.status === "done");
    const openRequired = m.tasks.filter((t) => t.status !== "done" && !t.deferred);
    const acceptanceTask = m.tasks.find((t) => t.kind === "acceptance");
    if (done.length === m.tasks.length && (!acceptanceTask || acceptanceTask.status === "done")) {
      m.status = "accepted";
    } else if (openRequired.length === 0) {
      m.status = "code_complete";
    } else if (done.length > 0 || m.tasks.some((t) => t.status === "in_progress")) {
      m.status = "in_progress";
    } else {
      m.status = "pending";
    }
  }
}

export function validatePlan(state, bp) {
  const errors = [];
  const ids = new Set();
  for (const m of bp.milestones) {
    if (!m.key || typeof m.id !== "number") errors.push(`milestone missing key/id`);
    m.tasks.forEach((t, i) => {
      if (t.index !== i) errors.push(`${t.id}: index ${t.index} != position ${i}`);
      if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
      ids.add(t.id);
      if (!TASK_STATUSES.has(t.status)) errors.push(`${t.id}: bad status ${t.status}`);
    });
    for (const r of m.requires ?? []) {
      if (!bp.milestones.some((x) => x.key === r.milestone))
        errors.push(`${m.key} requires unknown ${r.milestone}`);
    }
  }
  for (const { task } of allTasks(bp)) {
    for (const dep of task.depends_on ?? [])
      if (!ids.has(dep)) errors.push(`${task.id} depends on unknown ${dep}`);
  }
  for (const k of ["status", "last_engineer_used", "handoff_instructions"]) {
    if (!(k in state)) errors.push(`state.json missing ${k}`);
  }
  return errors;
}
