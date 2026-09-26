# CLAUDE.md — Repository Rules

You are implementing Back Office OS.

Read these files before making architectural changes:
1. `docs/MASTER_SPEC.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. `docs/MILESTONES.md`

## Non-negotiable engineering rules

1. Multi-tenant isolation is mandatory.
2. Every tenant-owned domain record carries `organization_id`.
3. Every exposed tenant table uses RLS.
4. AI prompts never enforce authorization.
5. AI does not directly mutate external financial/business systems.
6. Sensitive actions go through validated domain tools and policy checks.
7. All external side effects must be idempotent.
8. Every consequential action gets an audit log.
9. Provider SDKs stay in integration adapters.
10. Domain code is provider-independent.
11. Prefer a modular monolith over premature microservices.
12. Use strict TypeScript.
13. Tests must cover tenant isolation, permissions, idempotency, and approval behavior.
14. Never silently guess ambiguous business data; create draft/clarification/ops case.
15. Do not add features outside the active milestone unless they are required foundations.

## Product rule

Customers buy **completion**, not AI.

The system must have an explicit human escalation path for uncertain workflows.

## Current milestone

Tracked in `workflow/state.json` (plan in `workflow/blueprint.json`). M1 brief: `.claude/IMPLEMENT_M1.md`.

## Back-Office Automation Protocol

Any AI model working in this repository MUST follow these rules. They add to the engineering
rules above and never override them.

1. **Read state first.** Before writing any code, read `workflow/state.json` and
   `workflow/blueprint.json`. The current task is
   `milestones[id == current_milestone_id].tasks[current_task_index]`.
2. **One isolated task at a time.** Execute exactly one blueprint task per step. Do not start the
   next task, and do not touch files unrelated to the current task.
3. **Constantly update state.** After every step, update `workflow/state.json`:
   - `status`: `AWAITING_REVIEW` (task complete, ready for review), `IN_PROGRESS` (more steps
     needed), `NEEDS_HUMAN` or `BLOCKED` (explain why).
   - `last_engineer_used`: the model/engineer that performed the step.
   - `handoff_instructions`: clear text stating exactly which files and code were modified, and exactly
     what needs to happen next.
   The referee (`workflow/scripts/autopilot.mjs`) owns everything else: it increments
   `current_task_index`, moves between milestones, counts `attempts`, and sets task statuses in
   `workflow/blueprint.json`. Builders must not edit those fields or `blueprint.json`.
4. **Micro-commit rule.** Aim for at most 150 changed lines per file per step; the hard limit is 200.
   If a task needs more, split it into multiple steps (`IN_PROGRESS`) and record the remaining work in
   `handoff_instructions`. The referee rejects and discards steps over the hard limit.
5. **Valid JSON always.** Both workflow files must remain valid JSON after every edit.
6. **Never skip the gate.** Run lint, typecheck and tests before `AWAITING_REVIEW`; the referee reruns
   them and sends failing steps back.
7. **If `review_notes` is set, address it first.** It holds the reviewer's or referee's feedback.
8. **Never edit the autopilot's own files**: `.github/`, `workflow/scripts/`,
   `workflow/config.json`. Never commit or push; the pipeline does that.

### Autopilot roles (see `workflow/README.md`)

- **Builder: Claude.** Implements one step of the current task.
- **Reviewer: ChatGPT.** Approves or requests changes on each completed task.
- **Referee: a deterministic script.** Decides whose turn it is, enforces these rules, and advances
  the plan.

It runs on a schedule in GitHub Actions and stops for a human at `NEEDS_HUMAN`, `BLOCKED`, `PAUSED`
and milestone boundaries.
