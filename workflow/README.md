# Autopilot — Claude + ChatGPT build Back Office OS on their own

## How it works

Every 30 minutes, GitHub Actions (in the cloud, so your computer can be off) runs **one turn**: a Claude build step, followed in the same run by ChatGPT's review whenever that step finishes a task.

```text
                 ┌────────────── referee (workflow/scripts/autopilot.mjs) ──────────────┐
state.json says  │ READY_TO_START / IN_PROGRESS / CHANGES_REQUESTED → Claude builds a step │
                 │ AWAITING_REVIEW                                   → ChatGPT reviews    │
                 │ NEEDS_HUMAN / BLOCKED / PAUSED / MILESTONE_COMPLETE → stop, wait for you│
                 └──────────────────────────────────────────────────────────────────────────┘
```

1. **Claude (builder)** reads `state.json` and the current task in `blueprint.json`. It makes one
   small step (≤40 changed lines per file), runs lint/typecheck/tests, and writes a handoff note.
2. **The referee** reruns lint/typecheck/tests. It then:
   - rejects and discards the step if it broke a rule (protected files, line limit, no handoff);
   - otherwise commits it to the **`autopilot`** branch.
3. **ChatGPT (reviewer)** gets the task, the rules in `CLAUDE.md` and the diff, and approves or
   requests changes. On approval the referee marks the task done and moves to the next one.
4. After 3 failed attempts on one task, it stops as `BLOCKED` for you.

**Running out of tokens is safe.** Progress lives in git, not in a chat. If Claude or ChatGPT hits a
limit mid-run, that run's partial work is discarded and the next run picks up the same task.

**You get notified when it needs you.** It opens a GitHub issue that @mentions you (GitHub emails you, and pushes to the GitHub mobile app if installed) when a task needs a person, a task is blocked, a milestone finishes, or Claude/ChatGPT fail 3 runs in a row (e.g. expired token, no API credits). The issue closes itself once the autopilot is moving again.

**It stops for you at:**
- tasks flagged `requires_human` (live phone calls, QuickBooks credentials, browser walkthroughs);
- the end of each milestone (so you can check the acceptance criteria);
- `BLOCKED`.

Each stop has a note in `handoff_instructions`.

## One-time setup

1. **Create an empty public GitHub repository** at <https://github.com/new>. Don't add a README.
   - Public repos get free Actions minutes.
   - Everything committed is visible to anyone, including the plan, state and every autopilot commit.
   - Secrets stay hidden in GitHub's secret store.
   - Never commit `.env.local` (it is git-ignored) or paste keys into files.
2. **Push this project** from the repository root:
   ```bash
   git add -A
   git commit -m "M1 foundation + autopilot"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. **Add secrets** in the repo: Settings → Secrets and variables → Actions → New repository secret.

   | Secret | Where to get it | Billing |
   |---|---|---|
   | `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` in a terminal and paste the token | Uses your Claude subscription limits |
   | `OPENAI_API_KEY` | <https://platform.openai.com/api-keys> | **OpenAI API billing, separate from a ChatGPT Plus/Pro subscription** |

   - Use `ANTHROPIC_API_KEY` instead of the OAuth token if you'd rather pay per use.
   - To run without ChatGPT, set `"provider": "none"` under `reviewer` in `workflow/config.json`. Tasks
     then auto-approve once the tests pass, with no second opinion.
4. **Turn it on.** Actions tab → enable workflows → **autopilot** → **Run workflow** → `step`. Watch
   the first run; after that it runs hourly on its own.

## Day-to-day

- **See progress:**
  - the `autopilot` branch's commit history (one commit per turn);
  - each run's summary in the Actions tab;
  - `node workflow/scripts/autopilot.mjs status` locally, after `git pull`.
- **Controls** (Actions → autopilot → Run workflow):
  - `pause`
  - `resume`: continue after BLOCKED / NEEDS_HUMAN / milestone pause
  - `resume-mark-done`: you finished the current human task
  - `mark-task-done` + task id: you finished a skipped (deferred) human task, e.g. `M2-T17`
  - `step`: run one turn now
- **Kill switch:** Actions → autopilot → ⋯ → Disable workflow.
- **Ship it:** open a pull request from `autopilot` into `main` whenever you want to review and
  merge. Do this at least at every milestone pause.
- **Settings** in `workflow/config.json` on `main`:
  - models;
  - attempts before BLOCKED;
  - line limit;
  - `pause_at_milestone_boundary`.

  The schedule is the `cron` line in `.github/workflows/autopilot.yml`.

## Safety rails

- The referee and config are loaded from `main`. The AI can't loosen its own rules on the
  `autopilot` branch.
- Claude can't commit, push, or edit `.github/`, `workflow/scripts/`, `workflow/config.json` or
  `blueprint.json`. The referee discards any step that tries.
- Nothing reaches `main` without you merging it.
- The AIs have no production credentials. Tasks that need them stop at `NEEDS_HUMAN`.
- **Public repo safety:**
  - The workflow runs only on its schedule or on "Run workflow", which needs write access.
  - It never runs on forks, pull requests, issues or comments, so strangers can't trigger it, feed
    it instructions, or reach the secrets.
  - Keep it that way: don't add `pull_request_target`, `issues` or `issue_comment` triggers.
