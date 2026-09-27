# Autopilot (v2)

Claude builds, an OpenAI model reviews, and a deterministic **referee** decides. It runs in GitHub
Actions every 30 minutes (your computer can be off). Progress and every decision live in git on the
`autopilot` branch.

## One run

```text
next ──► build     Claude makes ONE step ─► referee runs the checks ─► referee judges the step
    ├──► validate  re-run the checks on a finished task (after an infrastructure failure)
    ├──► review    reviewer judges the COMPLETE task diff, only if the checks passed on exactly that code
    └──► stop      paused / blocked / waiting for a person
```

## What "done" means (three levels, never conflated)

| Level | Means | Recorded as |
|---|---|---|
| Step validated | format, lint, typecheck, tests (incl. production build + browser secret scan), timezones passed on this code | `state.last_validation` (with a code fingerprint) |
| Task accepted | reviewer approved every part of the complete diff of the validated code | `task.verification.level = reviewed_and_validated` |
| Milestone accepted | its acceptance task passed the end-to-end suite (and the local Supabase stack) **and** every human check is done | `milestone.status = accepted` |

A milestone whose only open items are deferred human checks is `code_complete`, **not** accepted, and
nothing is production-ready while those checks are open. Tasks accepted before the 2026-09 repair
carry `verification.level = review_only_pre_repair`.

## Rules the referee enforces

- **Task selection:** first task that is not done, not deferred, has its `depends_on` done, and whose
  milestone's `requires` are met (M3's remaining work waits for M2's automated acceptance; M4+ waits
  for M2, M3 and production hardening).
- **Step size:** target 150, hard limit 200 changed lines per file. Exceptions must be declared and
  verified: `formatting` (must equal Prettier's output), `generated` (configured paths), `atomic`
  (reason required, ≤400 lines, shown to the reviewer). Lockfiles are exempt.
- **Nothing useful is thrown away:** oversized or unfinished work is saved to
  `workflow/wip/<task>.patch` and offered to the next run. Unfinished runs cost no attempt; three in a
  row block the task with an explanation (it is probably too big).
- **Protected:** the builder cannot change `workflow/` (except `state.json`), `.github/`, `CLAUDE.md`,
  repository-wide config, check scripts in any `package.json`, or existing vitest/eslint/tsconfig
  files. Such steps are discarded.
- **Tests with behavior:** a finished task that changes source without touching tests is sent back.
- **Review:** full diff, split by file into tracked parts (all must approve), with acceptance
  criteria, check results and changed interfaces. A file too large for one part goes to a person.
  Repository content and handoffs are passed as untrusted data. Code that changed after validation is
  never reviewed.
- **Failures:** infrastructure failures (network, out of memory, Docker) cost no attempt; three sent-back
  attempts block a task; 8 failed runs in a row (2 for errors that won't fix themselves, like a bad
  key or no credits) **pause** the autopilot with the reason.

## Where to look

- `workflow/STATUS.md`: current task, last validation, milestone levels, blocked/deferred work, recent decisions
- `workflow/history.jsonl`: every referee decision, review verdict, exception and failure
- GitHub issues titled `[autopilot] …`: you are needed (they close themselves when resolved)

## Controls (Actions → autopilot → Run workflow)

`step` (run a turn now) · `pause` · `resume` · `resume-mark-done` (you finished the current human
task) · `mark-task-done` + task id (you finished a deferred human task, e.g. `M2-T17`).
Kill switch: set `"enabled": false` in `workflow/config.json` on `main`, or disable the workflow.

## Secrets (repo Settings → Secrets → Actions)

`CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) and `OPENAI_API_KEY`. The workflow uses only
`contents: write` and `issues: write` permissions and never runs on forks, pull requests or comments.

## Changing the automation

The referee, its tests (`pnpm test:workflow`) and `workflow/config.json` live on `main` and are changed
by people through reviewed commits. Changes to `.github/workflows` must be merged into `autopilot` by
a person once (GitHub's token cannot push workflow changes).
