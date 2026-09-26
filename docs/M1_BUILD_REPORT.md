# M1 Build Report — Business Brain + Owner Inbox Foundation

> Follow-up: local live-stack verification is now complete. See [M1 live verification](M1_LIVE_VERIFICATION.md) for results and the small UI fix, and [M2 readiness](M2_READINESS.md) for the next milestone. The original report below records the pre-verification state.

Date: 2026-09-25 · Plan: `docs/M1_IMPLEMENTATION_PLAN.md`

**Status:** The completion gate passes. `pnpm lint`, `pnpm typecheck` and `pnpm test` (133 tests) all
succeed, and every required test in `.claude/IMPLEMENT_M1.md` exists and passes.
**Caveat:** this machine had no running Docker daemon and no Supabase CLI, so nothing ran against a live
Supabase stack. The database tests use real Postgres semantics (PGlite, which is PostgreSQL 18.3
compiled to WASM) plus a Supabase compatibility shim. The first live run is a checklist item before M2
(see §4 and §6).

---

## 1. What was implemented

### Workspace

| Path | Contents |
|---|---|
| `package.json`, `pnpm-workspace.yaml` | pnpm workspace; root `lint` / `typecheck` / `test` / `build` / `format` scripts |
| `tsconfig.base.json` | strict TS (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |
| `eslint.config.base.mjs`, `.prettierrc.json` | ESLint 9 + typescript-eslint strict; Prettier |
| `packages/domain` | Provider-independent domain: types, roles, permission matrix, approval-authority policy engine, zod input schemas, domain errors, event type catalogue |
| `packages/core` | Business Brain services/repositories behind a tiny `SqlExecutor` interface; `pg` adapter; all DB/RLS/authorization tests |
| `apps/web` | Next.js 16 App Router: Owner Inbox, records pages, settings, Ops Console, auth, server actions |
| `supabase/migrations/0002_m1_foundation.sql` | M1 schema and security foundation (0001 left untouched) |
| `supabase/config.toml`, `supabase/seed.sql`, `supabase/README.md` | Local Supabase config, demo data, migration docs |

### Domain services (`packages/core/src/services`)

Organization (onboarding with owner), Membership (list/add), Customer, Employee, Vendor, Job
(create/update), Task (create/list/complete), Approval (create/decide/list), BusinessRule (versioned
`approval.decide` delegation rules, retire), BusinessEvent (`recordEvent`, `listEvents`), AuditLog
(`writeAudit`, `listAudit`), OpsCase (tenant create/list; operator list/open/update),
InternalOperatorGrant (grant/revoke/list), Notes, and Document metadata.

### Owner Inbox and pages

- `/inbox`: pending approvals, sorted by risk. Each shows amount, requester, expiry and notes, with
  **Approve / Reject / Add note**. Buttons only appear when the policy engine says this user can decide;
  otherwise the card explains why. Also: open high/urgent tasks with *Mark done*, *New task*,
  *Request an approval*, and *Hand something to the Back Office team* (creates an ops case).
- `/customers`, `/jobs` (with status update), `/vendors`: list + create, shown or hidden by permission.
- `/settings`: crew directory, app users (add member), approval delegation rules (versioned), Back Office
  team access grants (grant/revoke), the tenant's escalations, and recent audit log.
- `/ops/cases`, `/ops/cases/[id]`: internal staff only (everyone else gets a 404). The queue shows only
  tenants with a live grant. Opening a case is audited. Operators can assign, change status, resolve and
  tag an automation-gap category.
- `/login` (email/password via Supabase Auth), `/onboarding` (create an org and become its owner),
  org switcher for multi-org users.

### Server actions (`apps/web/src/app/actions`)

`createApprovalAction`, `decideApprovalAction`, `addNoteAction`, `createTaskAction`,
`completeTaskAction`, `createOpsCaseAction`, record-creation actions, settings actions, and
`updateOpsCaseAction`. "Create event" and "create audit log" are server-internal functions
(`recordEvent`, `writeAudit`). They are deliberately **not** browser-callable server actions, because a
client-callable audit writer would let users forge the audit trail. A test enforces this.

---

## 2. Architecture decisions

1. **Two execution modes in one transaction** (`packages/core/src/db/tx.ts`).
   - `asUser` runs as Postgres role `authenticated` with the user's JWT claims, just like a Supabase
     client, so **RLS enforces tenant isolation on the server's own queries**.
   - `asService` runs as the table owner. It is used only for trusted writes (decisions, events, audit),
     and only after the code-level authorization check.
   - Because both modes share one transaction, a decision, its event and its audit record commit
     together or not at all. All settings are transaction-local, and a test proves nothing leaks across
     pooled connections.
2. **Authorization in code, with RLS as the ceiling.** `packages/domain/src/permissions.ts` is the role
   matrix. `approval-policy.ts` decides approval authority:
   - owner can decide anything;
   - office_admin can decide non-financial approvals, and financial ones only under a delegating rule;
   - RED approvals are owner-only, and no rule can change that;
   - manager, field employee, accountant, agents, integrations, system and operators can never decide.

   Rules are versioned data. A malformed rule is ignored (fails closed). No prompt text is involved
   anywhere.
3. **Clients are read-only for provenance tables.** Migration 0002 revokes client
   `insert/update/delete` on approvals, events, audit, ops cases, grants, rules, notes, orgs,
   memberships and internal_staff. A user holding their own JWT + anon key therefore cannot approve
   something or forge history through PostgREST.
4. **Every mutation is audited, whatever path made it.**
   - Service-level semantic audit covers decisions, grants, rules, notes, ops cases, org and member
     changes, and **authorization denials**. A denial is audited in a separate transaction after the
     rollback.
   - A DB trigger audits the tables clients *can* write (customers, employees, vendors, jobs, tasks,
     documents). It records column names only, not values, to avoid duplicating PII.
   - `audit_log` and `business_events` are append-only via triggers.
5. **Idempotency.**
   - Approval creation is unique on `(organization_id, idempotency_key)`. A reused key with different
     content is a conflict.
   - A decision takes a row lock and checks `status='pending'`. Its event key `approval.decided:<id>`
     is unique, and a DB trigger makes decided approvals immutable. A repeated identical decision
     returns the original result with no side effects; a conflicting decision is rejected.
   - Web forms carry a render-time idempotency key and disable submit while pending.
6. **Tenant-safe references.**
   - A composite FK stops jobs from referencing another org's customer.
   - Polymorphic `entity_type/entity_id` references and task assignees are checked for same-org
     membership in code.
7. **Internal operators.** Internal staff live in a separate `internal_staff` table, not a tenant role.
   Tenant access requires a grant that has a reason and an expiry (1h–7d), was created by that tenant's
   owner, and can be revoked. Staff who are also tenant members still need a grant on the Ops Console
   (explicit `has_operator_grant` filter).
8. **Adapters.**
   - Supabase Auth sits behind `AuthProvider` (`apps/web/src/server/auth`).
   - The DB driver sits behind `SqlExecutor`/`Database`.
   - Domain code imports neither.
9. **Fixes to 0001, made in 0002 without editing 0001.**
   - `membership_select` recursed into its own table, which Postgres rejects at query time. It now
     uses the definer helper.
   - `webhook_receipts` had no RLS and was fully exposed to `anon` under Supabase default grants. It now
     has RLS enabled and client privileges revoked.
10. **Dependency choices.**
    - ESLint is pinned to 9, because `eslint-plugin-react` (via `eslint-config-next`) does not run on
      ESLint 10.
    - TypeScript is pinned to 5.9 rather than the TS 7 native port.
    - Next 16 uses `proxy.ts` (the renamed middleware).

---

## 3. Test results

Final run of the completion gate from the repository root:

```text
pnpm lint        -> exit 0 (domain, core, web)
pnpm typecheck   -> exit 0 (domain, core, web)
pnpm test        -> exit 0
  packages/domain  policy.test.ts            20/20
                   schemas.test.ts            6/6
  packages/core    tenant-isolation.test.ts  29/29
                   approvals.test.ts         31/31
                   ops-access.test.ts        17/17
                   audit-integrity.test.ts   15/15
                   pg-adapter.test.ts         4/4
  apps/web         boundaries.test.ts         7/7
                   secret-bundle.test.ts      4/4   (runs a real `next build`)
  TOTAL                                     133/133
pnpm format:check -> all files formatted
```

### Required tests

| # | Requirement | Where | How |
|---|---|---|---|
| 1 | org A user cannot read org B customer | `tenant-isolation.test.ts` | Raw SQL as the user (RLS only) returns 0 rows; the service throws Forbidden in org B's context and NotFound when targeting B's id from A; all roles checked; denial audited |
| 2 | org A user cannot update org B job | `tenant-isolation.test.ts` | RLS update affects 0 rows and the row is unchanged; moving a job to B and inserting into B are rejected by RLS; the service rejects |
| 3 | field employee cannot approve owner's financial approval | `approvals.test.ts` | Service throws Forbidden, status stays pending, and no event/audit is written except a denial audit; direct DB update is denied; field employee can't even see it |
| 4 | deciding twice does not execute twice | `approvals.test.ts`, `pg-adapter.test.ts` | Sequential replay → `replayed: true`, same event; 3 simultaneous calls → one execution; conflicting decision rejected; DB trigger blocks changes to decided approvals |
| 5 | decision creates business event | `approvals.test.ts` | Exactly one `approval.decided` event with actor, entity, idempotency key and policy source |
| 6 | decision creates audit log | `approvals.test.ts` | Exactly one `approval.decided` audit record linked to the approval and its source event |
| 7 | service-role secret never in browser bundle | `secret-bundle.test.ts`, `boundaries.test.ts` | Production build with sentinel `DATABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`; scans `.next/static` and all build artifacts; a positive control proves client code was scanned; static guards cover `server-only`, client imports and `NEXT_PUBLIC_` names |
| 8 | operator cannot access tenant without scoped grant | `ops-access.test.ts` | Checked with no grant, a grant for another org, revoked, expired, deactivated staff, non-staff user holding a grant row, and staff who is a tenant member; case opens are audited |

### Checking that the tests can fail

I deliberately broke each protection below, confirmed the tests went red, and restored the code (the
restored code is what the final run above tested):

| Deliberate break | Tests failed |
|---|---|
| RLS policy leaking customers | 5 |
| Re-granting direct approval updates | 2 |
| Removing the pending/replay guard | 3 |
| Removing the operator grant filter | 1 |
| Skipping the policy engine | 4 |
| Exposing `DATABASE_URL` to a client component via `next.config` `env` | 2 (the leak showed up in client chunks) |

### Other verification

- The production `pg` adapter was exercised over the Postgres wire protocol (pglite-socket) in
  `pg-adapter.test.ts`.
- A production server (`next start`) was smoke-tested: all 11 routes built; `/`, `/inbox`,
  `/customers` and `/ops/cases` redirect unauthenticated users to `/login`; `/login` renders.

---

## 4. Known limitations

- **Not yet run against a live Supabase stack.** Docker was not running and the Supabase CLI was not
  installed. Consequences:
  - The migrations were verified on PGlite with a shim, not on Supabase's PG 17.
  - `supabase/config.toml` and `supabase/seed.sql` (auth.users/identities inserts) are **unverified**.
  - The authenticated UI flows (sign-up, sign-in, clicking Approve) were not run end-to-end in a
    browser. Only the unauthenticated paths were smoke-tested.
- **True parallel concurrency is not exercised.** PGlite is single-session, so the "3 simultaneous
  decisions" test serializes. Correctness under real parallel connections relies on the row lock +
  unique event key + immutability trigger (standard Postgres semantics).
- **No downstream execution on approval.** M1 records `approval.decided`. Nothing yet consumes it by
  design, so M2+ consumers must key on the approval id or event id to stay idempotent.
- **Expired approvals** can't be decided and are hidden from the inbox, but no sweeper marks them
  `expired` yet.
- **Membership management** is add-only, for existing accounts, and non-owner roles only. There is no
  UI for role change or removal, and no invitations.
- **MFA, re-authentication, and two-step verification** for role/owner changes (SECURITY.md §4, §8)
  are not implemented.
- **Internal staff** are managed by SQL only. Operators cannot request a grant in-app.
- **Documents** are metadata-only (service, no UI). There is no storage upload yet.
- **Time zones.** `datetime-local` inputs are interpreted in the server's time zone, not the org's.
- **No pagination** on lists, **no UI/e2e tests**, and **no rate limiting** beyond Supabase Auth's own.
- **Org hard-deletion** is blocked by the append-only audit/event triggers (intentional). It needs a
  deliberate maintenance procedure (`app.allow_append_only_maintenance`).
- `packages/agents`, `packages/integrations` and `packages/workflows` (named in README) are not
  created. They belong to M2.

## 5. Security concerns

1. **`DATABASE_URL` is highly privileged.** It is the table owner and bypasses RLS for trusted writes.
   It is server-only and a test checks it never reaches the browser. For production, use a dedicated
   least-privilege role and rotate the credential.
2. **Two assumptions must be verified on real Supabase.**
   - The `postgres` role owns the tables, so its trusted writes bypass RLS.
   - The `postgres` role can `SET ROLE authenticated`.

   Both hold in the shim. If either fails on Supabase, user-scoped queries or trusted writes will error
   loudly; they will not fail open.
3. **The trusted-write path depends on each service calling `ctx.authorize(...)` before any `asService`
   write.** Every current service does, and tests cover them. A future service that forgets would be a
   hole, so keep this on the review checklist, or add a lint rule in M2.
4. **Staff can still write some tables directly through PostgREST.** Customers, vendors, jobs, tasks,
   employees and documents accept direct writes using a staff JWT + anon key. Those writes are
   RLS-scoped and trigger-audited, but they skip app-level validation and business events. Consider
   revoking direct writes once all writes go through the server.
5. **Denial audits are written to the *target* tenant's log.**
   - Useful: the owner can see who probed their org.
   - Cost: this reveals the prober's user id, and without rate limiting it could be used to spam that
     log.
6. **`SECURITY DEFINER` helpers** (`is_org_member`, `has_org_role`, `is_internal_staff`,
   `has_operator_grant`) are callable via RPC. They only answer questions about the caller.
7. **Audit records store changed column names, not values.** This is PII-safe, but limits forensic
   before/after reconstruction.
8. **`seed.sql` creates users with a known password.** It is for local use only (documented in the file
   and in `supabase/README.md`).
9. **Server actions** rely on Next's built-in Origin check for CSRF. Each action authenticates itself
   (enforced by `boundaries.test.ts`). The org always comes from the validated session, never from
   form input.

## 6. Exact commands to run locally

Prerequisites: Node ≥ 20.9 (tested on 24.21), pnpm 10 (`npm i -g pnpm@10`), Docker Desktop
**running**, and the Supabase CLI (<https://supabase.com/docs/guides/cli>).

```bash
cd backoffice-os-starter            # repository root (contains pnpm-workspace.yaml)
pnpm install

# Quality gate — needs no Docker or Supabase
pnpm lint
pnpm typecheck
pnpm test

# Local Supabase: applies supabase/migrations/* and supabase/seed.sql
supabase start
supabase status                     # note "API URL", "anon key", "DB URL"

# App configuration
cp apps/web/.env.example apps/web/.env.local
#   NEXT_PUBLIC_SUPABASE_URL      = API URL        (http://127.0.0.1:54321)
#   NEXT_PUBLIC_SUPABASE_ANON_KEY = anon key
#   DATABASE_URL                  = DB URL         (postgresql://postgres:postgres@127.0.0.1:54322/postgres)

pnpm dev                            # http://localhost:3000
```

Demo accounts from `seed.sql` (password `backoffice-dev-1`): `owner@acme.test`, `admin@acme.test`,
`crew@acme.test`, `owner@bravo.test`, `ops@backoffice.test`.

Suggested walkthrough:

1. As the owner, approve the $450 rock purchase and approve it again. The second attempt reports
   "already approved" and nothing repeats.
2. As `admin@acme.test`, note the financial approval says it needs the owner. Add a rule in Settings
   and try again.
3. As `ops@backoffice.test`, the queue is empty. As the owner, grant that email in Settings; the case
   now appears, and opening it shows in the owner's audit log.

**Next command to run locally:** `supabase start`, then `pnpm dev`, then work through the walkthrough
above. This is the live-stack verification that §4 flags as outstanding.

## 7. What is ready for Milestone 2

- **Somewhere safe for calls to land.**
  - Agents and integrations can call `createTask`, `createApproval` and `createOpsCase` as `agent` /
    `integration` actors, restricted to GREEN permissions.
  - Every write is attributed and audited (`actor_label`, e.g. `agent:receptionist`).
- **Idempotent event log.**
  - `recordEvent` is unique on `(organization_id, idempotency_key)`, ready for provider event ids.
  - `webhook_receipts` is locked down (RLS on, no client access), ready for M2's webhook
    receipt/dedupe logic.
- **Human escalation.** Ops cases with reason codes, SLA, evidence, operator workflow and
  automation-gap tagging.
- **Adapter seams.** `AuthProvider` and `SqlExecutor` show the pattern. M2's `VoiceProvider` / SMS
  adapters belong in a new `packages/integrations`, with agent tool contracts in `packages/agents`.
- **Test harness.** `createWorld()` provides two tenants with every role plus an operator, and there
  are raw-RLS helpers. New tables should get the same "org A cannot see org B" coverage.

Before starting M2, do the live-stack check in §6 on a real Supabase project. In particular, confirm
the two role assumptions in §5.2 and that `seed.sql` signs in.
