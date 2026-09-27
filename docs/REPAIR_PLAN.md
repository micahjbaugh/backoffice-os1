# Foundation Repair Plan

Started 2026-09-26 against `autopilot` @ `e2cbac9` (findings were raised at `54dea8c`; one task, M3-T08,
landed in between). Work happens on branch `repair/foundation`.

## Safety and recovery

- Autopilot paused by setting `enabled: false` in `main`'s `workflow/config.json` (the referee loads its
  config from `main`, so scheduled runs stop at the decision step without touching state).
- Recovery tags pushed: `recovery/pre-repair-main` (`e09fc2c`), `recovery/pre-repair-autopilot` (`e2cbac9`).
- No history is rewritten. Every change lands as a scoped commit on `repair/foundation`; formatting is a
  separate mechanical commit.

## Verified findings (against current code)

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | Stale dependency install | **Environment, not code.** `pnpm install --frozen-lockfile` succeeds with no lockfile change; every package declares what it imports. Links were stale because new packages arrived via `git pull` without a reinstall. | install log; manifest/import cross-check |
| 2 | DATE depends on timezone/driver | **Confirmed.** PGlite parses `date` as UTC midnight; node-postgres parses it as local midnight. `dateOnly()` reads local fields, correct for pg, wrong for PGlite west of UTC. | `2026-01-05` → `2026-01-04` in America/Chicago |
| 3 | M2 path not connected | **Confirmed.** `providers.ts` always builds fakes; the webhook handler records a receipt and returns 200; no tenant resolution, persistence, receptionist runtime, disposition wiring or recovery. **Also found:** fakes default to hard-coded webhook secrets in a public repo, so a deployment would accept forged webhooks. | `apps/web/src/server/providers.ts`, `webhook-route.ts`, `fakes/*` |
| 4 | Twilio parsing vs JSON handler | **Confirmed.** Adapter verifies form-encoded bodies; handler only `JSON.parse`s → every real Twilio webhook would 400. | `webhook-route.ts:32` |
| 5 | Webhook identity | **Confirmed.** Vapi event id = call id; Twilio = MessageSid. Status updates for one call/message collide. Official docs: Vapi sends **no event id**; Twilio marks retries with `I-Twilio-Idempotency-Token` and sends several status callbacks per MessageSid. | adapters; provider docs |
| 6 | Outbound idempotency in memory | **Confirmed.** Adapter maps are per-process; `transferCall` calls the provider inside the DB transaction before event/audit commit. | `transfer.ts:94` |
| 7 | Billable-opportunity authority | **Confirmed and broader.** `billable_opportunities`, `time_entries`, `equipment_usages`, `material_usages` all let owner/admin/manager write every column including `status` through PostgREST. | migrations 0007–0009 |
| 8 | Memory / formatting | **Confirmed.** Core suite OOMs with default workers (12 PGlite instances). 40 committed files unformatted (+~48 more locally from CRLF checkout on Windows). | test log; prettier on committed blobs |

## Changes, in priority order

### 1. Reproducible checks and safe automation
1. `.gitattributes` (LF) + one mechanical Prettier commit; CI checks formatting.
2. Bounded vitest workers for DB-heavy suites.
3. `ci.yml`: clean frozen install, format, lint, typecheck, tests, production build + secret scan,
   timezone matrix, real-Supabase live-stack job. Pushes/PRs only; no secrets exposed to forks.
4. Referee upgrade (tested with `node --test`):
   - resumable steps: target 150 / hard 200 lines per file, reviewable exceptions (lockfile, generated,
     formatting-only, declared atomic up to a cap); over-limit or unfinished work preserved as a WIP
     patch instead of discarded;
   - three success levels: step validated → task accepted (review + required checks at the reviewed
     commit) → milestone accepted (automated acceptance suite + human checks);
   - review: full diff split into tracked parts (never truncated), acceptance criteria and check
     results included, repository content framed as untrusted, findings recorded in
     `workflow/history.jsonl`; a single oversized file goes to a human;
   - dependencies (`depends_on`), deferred human checks that block milestone acceptance, M4+ gated on
     M2/M3 automated acceptance;
   - gate classification (infrastructure vs code), bounded retries, automatic pause with explanation;
   - protected: automation files, `CLAUDE.md`, and the check scripts in every `package.json`;
   - atomic state writes; least-privilege workflow permissions; generated `workflow/STATUS.md`.

### 2. Date and permission correctness
- DATE (OID 1082) returned as `YYYY-MM-DD` text by both adapters; `dateOnly` rejects `Date` objects.
  Tests under UTC, America/Chicago, Asia/Tokyo via a runner that sets `TZ` per child process.
- Migration: split `*_staff_all` policies; clients may create/edit **drafts** only; `status` and
  decision columns not client-updatable; decided rows immutable to clients. Decision services:
  time/usage approval (owner/admin/manager, audited); billable opportunities through the approval
  policy (financial → owner unless delegated). Direct-API bypass tests.

### 3. Webhook ingestion and durable side effects
- Migration: `provider_routes` (trusted tenant resolution), webhook event store (derived event
  identity, delivery id, validated/redacted payload, processing state, attempts, backoff),
  `outbound_operations` outbox with tenant+operation-scoped keys and request hashes.
- Handler: verify signature on the original body → parse by provider format → validate → derive
  identity → durable insert → 2xx. Malformed → 400; bad signature → 401; not configured → 503.
- Processor: claims with `FOR UPDATE SKIP LOCKED`, dispatches by type, monotonic status updates for
  out-of-order delivery, bounded retries with backoff, dead-letter → ops case.
- Outbox worker: record intent atomically with the domain change; call providers outside DB
  transactions; ambiguous outcomes (timeout/crash) become `unknown` and are reconciled or escalated,
  never blindly retried. No exactly-once claims.
- Provider selection: fakes only outside production and only with explicit secrets; production fails
  closed and rejects known fake secrets. Fake default secrets removed.

### 4. Complete M2 integration and automated acceptance
Explicit blueprint tasks for each remaining connection (receptionist runtime for synchronous Vapi
events, lead/callback tools on the runtime, SMS reply path, outbound worker scheduling, reconciliation
jobs), plus an automated M2 acceptance suite on realistic fixtures. M2 live-phone check stays deferred
and visibly pending.

### 5. Remaining M3 work
Resumes after the above; M4–M10 blocked until M2/M3 automated acceptance passes.

## Production hardening (tracked separately)
Least-privilege DB role, rate limiting, MFA/re-auth, pagination, document storage, retention,
monitoring, backup/restore. Implemented where verifiable here; the rest listed in
`docs/PRODUCTION_HARDENING.md` as explicit tasks and human decisions.
