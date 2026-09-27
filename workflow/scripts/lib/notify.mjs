// GitHub issues that @mention the repo owner when a person is needed. Issues for stop states close
// themselves once the autopilot is moving again; milestone and "waiting for you" notices stay open
// until the owner closes them.

import { allTasks, currentTask } from "./plan.mjs";

export const ISSUE_PREFIX = "[autopilot]";
export const REVIEW_PREFIX = "[autopilot review]";

export function stopNotice(state, bp, { owner, repo, failureThreshold }) {
  const found = currentTask(state, bp);
  const task = found?.task;
  const actionsUrl = `https://github.com/${repo}/actions/workflows/autopilot.yml`;
  const reasons = {
    NEEDS_HUMAN: ["needs you for a task", "Do the task, then Run workflow → **resume-mark-done**."],
    BLOCKED: [
      "is blocked",
      "Read the notes, fix or adjust the plan, then Run workflow → **resume**.",
    ],
  };
  if (reasons[state.status]) {
    const [label, action] = reasons[state.status];
    return {
      title: `${ISSUE_PREFIX} ${label}: ${task?.id ?? "plan"}`,
      body: [
        `@${owner} the autopilot ${label}.`,
        "",
        `**Task:** ${task?.id ?? "—"} ${task?.title ?? ""}`,
        `**Details:** ${state.handoff_instructions}`,
        state.review_notes ? `\n**Notes:** ${state.review_notes.slice(0, 3000)}` : "",
        "",
        `**What to do:** ${action}`,
        `Controls: ${actionsUrl}`,
      ].join("\n"),
    };
  }
  if (state.status === "PAUSED" && state.pause_reason) {
    return {
      title: `${ISSUE_PREFIX} paused itself: ${state.pause_reason.slice(0, 80)}`,
      body: [
        `@${owner} the autopilot paused itself so it would stop repeating a failing run.`,
        "",
        `**Why:** ${state.pause_reason}`,
        state.last_error ? `**Last error:** ${state.last_error.slice(0, 1000)}` : "",
        "",
        "**What to do:** fix the cause (usually a secret, credits, or an outage), then Run workflow → **resume**.",
        `Controls: ${actionsUrl}`,
      ].join("\n"),
    };
  }
  if ((state.consecutive_failures ?? 0) >= failureThreshold) {
    return {
      title: `${ISSUE_PREFIX} keeps failing: ${state.consecutive_failures} runs in a row`,
      body: [
        `@${owner} the autopilot has failed ${state.consecutive_failures} runs in a row and is retrying.`,
        "",
        `**Last error:** ${state.last_error}`,
        "",
        "It pauses itself if this continues. Common fixes: API credits, refreshed secrets.",
        `Runs: ${actionsUrl}`,
      ].join("\n"),
    };
  }
  return null;
}

export function informationalNotices(state, bp, { owner, repo }) {
  const notices = [];
  for (const m of bp.milestones) {
    if (
      (m.status === "code_complete" || m.status === "accepted") &&
      !m.acceptance_verified &&
      m.automated_acceptance?.passed_at
    ) {
      notices.push({
        title: `${REVIEW_PREFIX} ${m.key} passed automated acceptance: please review`,
        body: [
          `@${owner} **${m.key}: ${m.name}** passed its automated acceptance suite (${m.automated_acceptance.passed_at}).`,
          m.status === "accepted"
            ? "All tasks, including human checks, are done."
            : "Human checks are still pending, so the milestone is **code-complete, not accepted**.",
          "",
          "Acceptance criteria:",
          ...(m.acceptance ?? []).map((a) => `- [ ] ${a}`),
          "",
          `Work: https://github.com/${repo}/compare/main...autopilot`,
        ].join("\n"),
      });
    }
  }
  const selected = state.current_task_id;
  const order = allTasks(bp).map((x) => x.task.id);
  for (const { task } of allTasks(bp)) {
    if (!task.deferred || task.status === "done") continue;
    if (selected && order.indexOf(task.id) > order.indexOf(selected)) continue;
    notices.push({
      title: `${REVIEW_PREFIX} waiting for you: ${task.id} ${task.title}`,
      body: [
        `@${owner} the autopilot is continuing with independent work, but this needs a person.`,
        "",
        `**${task.id}: ${task.title}**`,
        task.description,
        "",
        `**Why:** ${task.requires_human ?? "Marked as human work."}`,
        `**Done when:** ${task.done_when}`,
        "",
        `When finished: https://github.com/${repo}/actions/workflows/autopilot.yml → Run workflow → **mark-task-done**, task id **${task.id}**.`,
      ].join("\n"),
    });
  }
  return notices;
}

export async function syncIssues({ state, bp, repo, token, owner, failureThreshold, apiBase }) {
  const api = async (path, init = {}) => {
    const response = await fetch(`${apiBase}/repos/${repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
    });
    if (!response.ok)
      throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  };
  const need = stopNotice(state, bp, { owner, repo, failureThreshold });
  const open = (await api(`/issues?state=open&per_page=100`)).filter(
    (i) => !i.pull_request && i.title.startsWith(`${ISSUE_PREFIX} `),
  );
  let result = open.length ? "closed" : "none";
  if (need && open.some((i) => i.title === need.title)) result = "already-open";
  else {
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
    if (need)
      result = (await api(`/issues`, { method: "POST", body: JSON.stringify(need) })).html_url;
  }
  const infos = informationalNotices(state, bp, { owner, repo });
  if (infos.length) {
    const existing = new Set((await api(`/issues?state=all&per_page=100`)).map((i) => i.title));
    for (const notice of infos)
      if (!existing.has(notice.title))
        await api(`/issues`, { method: "POST", body: JSON.stringify(notice) });
  }
  return result;
}
