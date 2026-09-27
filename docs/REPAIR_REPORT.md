# Foundation Repair Report (2026-09-26/27)

Plan: `docs/REPAIR_PLAN.md`. Branch: `repair/foundation`. Recovery tags:
`recovery/pre-repair-main`, `recovery/pre-repair-autopilot`. The autopilot was paused (config on
`main`) before any change and stayed paused throughout; scheduled runs were confirmed to stop at the
decision step.

## Findings: verdicts

| # | Finding | Verdict | Fix |
|---|---|---|---|
| 1 | Stale dependency install | **Not reproduced as a code defect.** Frozen-lockfile install succeeds; every package declares what it imports. Cause was a local checkout that pulled new packages without reinstalling. | CI and the autopilot gate always do a clean `pnpm install --frozen-lockfile`; setup documented in `START_HERE.md`. |
| 2 | DATE shifted by timezone/driver | **Confirmed** (`2026-01-05` → `2026-01-04` in America/Chicago under PGlite). | Both adapters return SQL `date` as text; `dateOnly()` refuses JS Dates. Timezone matrix test (UTC, Chicago, Tokyo), mutation-checked. |
| 3 | M2 path not connected | **Confirmed**, plus an extra finding: fake providers defaulted to public hard-coded webhook secrets (forgeable). | Tenant resolution via `provider_routes`, durable event store, processor for inbound SMS / status / call status / end-of-call, outbox worker, jobs endpoint, fail-closed provider selection. Receptionist runtime, route management, SMS acknowledgement, ops view, retention and the acceptance suite are explicit tasks M2-T18…M2-T26. |
| 4 | Twilio form bodies vs JSON handler | **Confirmed.** | Signature over the original request and exact public URL; provider-specific parsing (form for Twilio, JSON for Vapi) with validation; malformed → 400. Verified against Twilio's published signature example. |
| 5 | Webhook identities | **Confirmed** (Vapi: call id; Twilio: message SID; official docs: Vapi sends no event id, Twilio sends several status callbacks per message and marks retries with `I-Twilio-Idempotency-Token`). | Event identity separate from resource identity; duplicates counted, tampered retries flagged; out-of-order handling (monotonic call and message status); concurrent delivery safe (unique constraints, SKIP LOCKED); payload stored for recovery; 2xx only after durable acceptance; retries with backoff; dead letters to ops cases. |
| 6 | Outbound idempotency in memory | **Confirmed**, including the transfer calling the provider inside the DB transaction. | `outbound_operations` outbox (tenant + operation-scoped keys, request-hash conflict detection), worker outside transactions, rejected vs ambiguous outcomes, unknown outcomes never retried blindly, reconciliation (Vapi `GET /call`; Twilio status callback carrying the operation id), escalation once to a person. No exactly-once claim. |
| 7 | Billable-opportunity authority | **Confirmed and broader**: time entries, equipment usage and material usage had the same bypass. | Migration 0011: draft-only client writes, status/decision columns not client-writable, decided rows immutable, decider required; decision services (owner for billables via the approval policy; owner/admin/manager for time and usage). 29 tests incl. direct-API attempts. |
| 8 | Memory / formatting | **Confirmed**: OOM with 12 PGlite workers; 40 committed files unformatted (+~48 more locally from CRLF). | Worker cap (4, configurable); `.gitattributes` LF; one mechanical formatting commit; formatting enforced in CI and the gate. |

## Automation changes (referee v2)

Builder/reviewer/referee split and the 30-minute schedule are unchanged. New:
resumable steps (oversized/unfinished work saved as a patch, never silently discarded);
target 150 / hard 200 lines per file with verified exceptions (formatting = Prettier's exact output,
generated paths, atomic with reason ≤400 lines; lockfiles exempt); three recorded success levels
(step validated → task accepted → milestone accepted); dependency- and prerequisite-aware task
selection (M3 waits for M2's automated acceptance; M4+ for M2, M3 and hardening); full-diff review in
tracked parts with acceptance criteria, check results and interface changes, untrusted-content framing
and per-part verdicts in `workflow/history.jsonl`; reviews refused unless the exact code passed the
checks; deterministic gate run by the referee with infra-vs-code classification; bounded retries and
automatic pauses with a reason; protected automation files, `CLAUDE.md`, check scripts and test
configs; atomic state writes; least-privilege workflow permissions (`id-token` removed);
`workflow/STATUS.md` reporting by verification level with no readiness percentages.

## Verification evidence

Local (Windows, Node 24.21, pnpm 10.34.5), at the final commit:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | clean, no lockfile changes |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | pass / pass / pass |
| `pnpm test` | 473 tests pass: domain 40, integrations 49, agents 9, core 302 (+7 live-stack tests skipped without Docker), workflows 24, web 22 (incl. production build + secret scan), referee 27 |
| `pnpm test:tz` | 19/19 in each of UTC, America/Chicago, Asia/Tokyo |

CI on GitHub (`ci.yml`, clean Linux runner, Node 22): run 36284111416 on `repair/foundation`
passed both jobs: **checks** (frozen install, format, lint, typecheck, all tests incl. production
build + secret scan and referee tests, timezone matrix) and **live-stack** (local Supabase started
with every migration incl. 0011/0012 applied to real Postgres, `db reset` + seed, 7 live tests
through real Auth/PostgREST). The first run (36283800308) failed live-stack only because the test
required a hand-made `apps/web/.env.local`; fixed in `165f097` (key taken from `supabase status`).

Behavior demonstrated by tests (not mocked happy paths):
restart (new process/runtime completes pending work once), concurrency (concurrent deliveries → one
row; concurrent workers → one provider call), replay (duplicate/tampered webhooks, replayed
end-of-call → one disposition), crash recovery (worker dies after claiming a webhook; worker dies after
the provider call → unknown → reconciled, not re-sent), out-of-order delivery, dead-lettering,
bounded retries, direct-API authority bypass attempts. Mutation checks confirmed the key tests fail
when the protection is removed (RLS, decision guard, outbox retry rules, referee protections).

## Migrations and configuration

- `0011_draft_decision_authority.sql`, `0012_webhook_ingestion_and_outbox.sql`
- New env (server-only): `BO_PROVIDER_MODE`, `FAKE_PROVIDER_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL`, `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`,
  `INTERNAL_JOBS_SECRET` (see `apps/web/.env.example`)
- `workflow/config.json` v2; `.github/workflows/autopilot.yml` v2; new `.github/workflows/ci.yml`

## Remaining human actions

See `docs/PRODUCTION_HARDENING.md`. In short: provider credentials and numbers, the jobs scheduler,
hosting and hosted Supabase decisions (MFA, backups), and the M2 live phone check (M2-T17, deferred;
M2 cannot be accepted and nothing is production-ready until it passes).

## Backlog (in the plan, cannot be skipped)

M2-T18…T26 (route management, receptionist runtime for synchronous Vapi events, tool calls,
transfer destination, call↔lead linkage, SMS acknowledgement, ops view of stuck items, retention,
automated M2 acceptance suite), M2-T17 (human), remaining M3 tasks (after M2 automated acceptance),
PH-T00…T07 hardening (before any M4+ work).
