# M1 Implementation Plan — Business Brain + Owner Inbox Foundation

Status: plan written before implementation. Scope is Milestone 1 only (see `docs/MILESTONES.md`).
No voice, SMS, QuickBooks, procurement, or payroll work is in scope.

## 1. Implementation approach

### Workspace layout (pnpm modular monolith)

```text
apps/web                 Next.js (App Router) — Owner Inbox, Ops Console, auth, server actions
packages/domain          Pure, provider-independent domain: types, roles, permission matrix,
                         approval-authority policy engine, validation schemas, domain errors
packages/core            Business Brain services + repositories. Talks to Postgres through a
                         tiny `SqlClient` interface (no Supabase/pg types leak into services)
supabase/migrations      0001_core.sql (unchanged) + 0002_m1_foundation.sql (new)
supabase/seed.sql        Local-dev demo data
```

Internal packages are consumed as TypeScript source (Next `transpilePackages`), so there is no
package build step to keep in sync.

### Data access model

- The Next.js server talks to Postgres directly with `pg` using `DATABASE_URL` (server-only secret).
- **User-scoped work runs under RLS.** Each request opens a transaction, sets the Supabase-style JWT
  claims (`request.jwt.claims`) for the verified user and runs `SET LOCAL ROLE authenticated`. The same
  RLS policies that protect PostgREST therefore protect the server's own queries (defense in depth:
  a bug in an app-layer check cannot read or write another tenant's rows).
- **Trusted writes** (audit log, business events, approval decisions, ops cases, operator grants,
  org creation) happen in the *same transaction* after switching back to the connection's owner role
  (`RESET ROLE`). They are only reachable from server code that has already authenticated the user
  and passed the domain authorization check. This keeps "decision + event + audit" atomic.
- Supabase Auth (via `@supabase/ssr`) is used only for identity/session. It sits behind an
  `AuthProvider` adapter in `apps/web/src/server/auth`; domain code only sees a user id.
- The browser never receives `DATABASE_URL` or a service-role key. The only browser-visible Supabase
  values are the public URL and anon key. The app does not need the service-role key at all in M1.

### Services (packages/core)

Repositories/services for Organization, Membership, Customer, Employee, Vendor, Job, Task, Approval,
BusinessRule, BusinessEvent, AuditLog, OpsCase, plus Document metadata, Notes, and
InternalOperatorGrant. Every service function receives an explicit `ServiceContext`
`{ db, actor, organizationId }`; every tenant query filters on `organization_id` in addition to RLS.

Key operations:

| Operation | Authorization | Side effects |
|---|---|---|
| `createApproval` | member with `approval.request`, system, or agent | idempotent on `(organization_id, idempotency_key)`; event `approval.requested`; audit |
| `decideApproval` | policy engine (role + risk class + financial + business rules) | conditional update `where status='pending'` under row lock; event `approval.decided` (unique idempotency key); audit; replays are no-ops |
| `createTask` | `task.create` | event `task.created`; audit |
| `recordEvent` / `writeAudit` | server-internal only | append-only |
| `createOpsCase` | staff, system, or agent | event `ops_case.created`; audit |
| `grantOperatorAccess` / `revokeOperatorAccess` | org owner | audit |
| `openOpsCase` (internal) | internal staff **and** active, unexpired, unrevoked grant for that org | audit `ops_case.viewed` |

`createEvent` and `createAuditLog` are implemented as server-only service functions and are **not**
exposed as browser-callable server actions: a user-callable "write an audit record" action would let
users forge the audit trail. They are invoked by the other services inside the same transaction.

### Owner Inbox & Ops Console (apps/web)

- `/login`, `/onboarding` (create first organization; creator becomes owner)
- `/inbox` — pending approvals (approve / reject / add note) + open high/urgent tasks + create task
- `/customers`, `/jobs`, `/vendors` — list + create
- `/settings` — organization, members, business rules (approval delegation), operator grants, recent audit log
- `/ops/cases`, `/ops/cases/[id]` — internal staff only; lists only cases in tenants with a live grant
- Current organization is a cookie that is re-validated against memberships on every request.

## 2. Architecture decisions

1. **New migration, not edits.** `0001_core.sql` is treated as deployed. `0002_m1_foundation.sql`:
   - fixes `membership_select` (it self-references `memberships` inside its own policy, which
     Postgres rejects with "infinite recursion detected in policy");
   - adds `internal_staff`, grant `revoked_at`, approval `risk_class`, a `notes` table;
   - adds check constraints for task/job/ops-case status and priority vocabularies;
   - adds write policies for staff on employees/tasks/documents/notes, member read policies for
     rules/events/audit/ops cases (role-restricted), and operator-grant read policies;
   - **revokes direct client `insert/update/delete` on approvals, events, audit log, ops cases, grants,
     organizations, memberships, internal_staff** — these only change through server services, so a
     user holding their own JWT + anon key cannot bypass the audit trail through PostgREST;
   - makes `audit_log` and `business_events` append-only via triggers;
   - makes decided approvals immutable via trigger (DB-level backstop for idempotency);
   - adds DB-level audit triggers on the tables clients *can* write directly (customers, employees,
     vendors, jobs, tasks, documents, notes, business_rules), so every record mutation is audited no
     matter which path made it.
2. **Authorization lives in code, twice.** The TypeScript policy engine (`packages/domain/policy`) is
   the source of truth for "may this actor do this"; RLS is the tenant-isolation and role ceiling.
   No prompt text participates in authorization.
3. **Approval authority.** Defaults: `red` risk → owner only, never delegable; financial approvals
   (amount present or financial type) → owner; other approvals → owner or office_admin. Owners can add
   versioned business rules (`action = 'approval.decide'`) delegating specific approval types up to an
   amount limit to `office_admin`. Rules can never grant authority to manager, field_employee or
   accountant_readonly. Agents and integrations can never decide approvals.
4. **Idempotency.** Approval creation: unique `(organization_id, idempotency_key)`; replay returns the
   existing row with no new event. Decision: row lock + `status='pending'` guard + unique event key
   `approval.decided:<id>` + immutability trigger. Same decision replayed → returns the existing result;
   conflicting decision → `ConflictError`.
5. **Internal operators.** Internal staff are a separate table (not a tenant role). Access to a tenant
   requires an explicit, reasoned, expiring grant (default 24h, max 7 days) created by that org's
   owner; grants can be revoked; every case view is audited as `internal_operator`.
6. **Tests run on real Postgres semantics without Docker** using PGlite (Postgres compiled to WASM)
   with a small Supabase compatibility shim (`auth` schema, `auth.uid()`, `anon`/`authenticated`/
   `service_role` roles, Supabase default grants). The same migration files are applied.

## 3. Security assumptions

- Supabase Auth issues and verifies sessions; the server calls `auth.getUser()` (server-validated), never
  trusting an unverified cookie payload for identity.
- `DATABASE_URL` connects as the table-owner role (`postgres`), which bypasses RLS; it is therefore
  server-only, read through a `server-only` module, and never prefixed `NEXT_PUBLIC_`.
- PostgREST remains enabled for the `public` schema in Supabase. RLS + revoked privileges are designed
  so that anything reachable with a user JWT + anon key is (a) tenant-scoped and (b) either read-only
  or captured by audit triggers.
- `SECURITY DEFINER` helper functions pin `search_path` and only answer questions about the calling user.
- The shim used in tests mirrors Supabase's behavior but is not Supabase; the migrations must also be
  applied to a real Supabase project (documented in the build report) before production use.
- Out of M1 scope (documented as limitations): MFA enforcement, re-auth for sensitive settings,
  two-step verification for role/owner changes, rate limiting.

## 4. Test strategy

- **Unit (packages/domain, Vitest):** permission matrix, approval authority (roles × risk × financial ×
  rules × delegation ceiling), validation schemas.
- **Database + service integration (packages/core, Vitest + PGlite):** a fresh database per test file
  with both migrations applied. Required cases:
  1. org A user cannot read org B customer (RLS direct query and service)
  2. org A user cannot update org B job (RLS update affects 0 rows; service rejects)
  3. field employee cannot approve owner's financial approval (service `ForbiddenError`; direct
     table update denied at DB level; approval unchanged)
  4. deciding an approval twice does not execute twice (sequential and concurrent; one event, one
     decision audit record)
  5. approval decision creates a business event
  6. approval decision creates an audit log record
  7. *(apps/web)* service-role / DB secrets never appear in the browser bundle: `next build` with sentinel
     secret values, then scan `.next/static` for them; plus static checks that client components do not
     import server modules and no `NEXT_PUBLIC_` variable carries a secret
  8. internal operator cannot access a tenant without a scoped grant (no grant, expired grant, revoked
     grant, grant for another org, non-staff user holding a grant)
  Plus: append-only audit/events, audit triggers fire, approval creation idempotency, agents cannot
  decide approvals, business-rule delegation and its ceiling, membership policy no longer recurses.
- **Completion gate:** `pnpm lint`, `pnpm typecheck`, `pnpm test` all green before reporting M1 done.
