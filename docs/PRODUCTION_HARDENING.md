# Production hardening register

Status as of the 2026-09-26 foundation repair. "Done" means implemented **and** covered by automated
tests in this repository. Nothing here is production-ready until the open items are closed; the
autopilot tracks them as milestone **PH** (it must pass before any M4+ work starts).

| Area | State | Where / what remains |
|---|---|---|
| Tenant isolation (RLS + code) | Done | Every tenant table has RLS; direct-API bypass tests per table (`packages/core/test`). |
| Decision authority on drafts/billables | Done | Migration 0011 + `draft-decisions.ts`; clients can't set status. |
| Webhook authenticity | Done | Signature/secret verified on the original request; production refuses fake providers and placeholder/known secrets (`runtime-config.ts`). |
| Webhook durability & replay | Done | Durable acceptance before 2xx, event identity, retries/backoff, dead-letter to ops case (`webhooks.ts`, `webhook-processor.ts`). |
| Outbound side effects | Done (no exactly-once claim) | Outbox, ambiguous outcomes never re-sent, reconciliation/escalation. Neither Twilio's Messages API nor Vapi call control accepts an idempotency key. |
| Secrets never in the browser bundle | Done | Production build scanned for sentinel secrets on every test run. |
| Background job trigger | Code done; **scheduling is a human decision** | `POST /api/internal/jobs` with `INTERNAL_JOBS_SECRET`. Needs a scheduler (e.g. Vercel Cron, GitHub Actions, Supabase cron) calling it every ~1 min. |
| Least-privilege DB role | Done | `app_server` role (migration `0017_app_server_role.sql`): owns nothing, not superuser, `NOBYPASSRLS`. User paths still go through `SET LOCAL ROLE authenticated` (full RLS); trusted service writes (audit, events, decisions, webhook/outbox processing, non-human-actor domain writes) are scoped to an explicit per-table grant + policy list, not a blanket bypass. `DATABASE_URL` must point at `app_server`, never at the migration-owner role, in every deployed environment (`packages/core/test/hardening/least-privilege-role.test.ts`). |
| Rate limiting | Planned (PH-T01) | No limits yet on webhooks, sign-in, server actions. |
| Pagination | Planned (PH-T02) | List pages are unbounded. |
| Private document storage | Planned (PH-T03) | Metadata only; no storage buckets/signed URLs yet. |
| Monitoring & alerting | Planned (PH-T04) | Logs only; no health endpoint or alerting on dead letters/unknown operations. |
| Retention (payloads, transcripts) | Done | Per-organization windows on `organizations`; scheduled purge clears processed webhook payload bodies and ended communications' transcript/summary, never unprocessed/in-progress ones (`retention.ts`, `retention-purge.ts`). |
| MFA & re-authentication | **Human decision** (PH-T05, deferred) | Enable MFA in the hosted Supabase project; choose enforcement. |
| Backups & restore drill | **Human action** (PH-T06, deferred) | Hosted project, PITR plan decision, and a person-run restore drill. |

## Credentials and decisions only a person can provide

- Twilio: Account SID, auth token, a phone number, and the public HTTPS webhook URL
  (`/api/webhooks/sms`) configured in Twilio.
- Vapi: API key, server-URL secret, phone number/assistant configuration pointing at
  `/api/webhooks/voice`.
- `INTERNAL_JOBS_SECRET` (32+ random characters) and the scheduler that calls the jobs endpoint.
- `app_server`'s database password: after applying migration `0017_app_server_role.sql`, run
  `alter role app_server with password '<generated>';` once against the target project (never
  committed) and point `DATABASE_URL` at it, e.g.
  `postgresql://app_server:<password>@<host>:<port>/postgres`.
- Hosting/deployment target, hosted Supabase project, MFA and backup policy.
- The M2 live phone check (M2-T17) on a provisioned number after the automated suite passes.
