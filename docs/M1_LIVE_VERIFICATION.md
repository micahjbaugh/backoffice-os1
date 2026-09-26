# Back Office OS — Milestone 1 live verification

Verified September 25, 2026 against the local Docker/Supabase stack.

**Result:** M1's local live-stack verification passed. The project is ready to proceed to M2 Communications Core planning and implementation, subject to the documented production-hardening limitations.

## Environment

- Project: `C:\Users\Micah\Documents\backoffice-os-starter\backoffice-os-starter`
- pnpm 10.34.5; Docker server 29.8.0; project-local Supabase CLI 2.118.0.
- Supabase PostgreSQL image 17.6.1.171; migrations 0001 and 0002 and the local demo seed applied successfully.
- App: http://localhost:3000
- Supabase Studio: http://127.0.0.1:54323
- Local connection values are in ignored `apps/web/.env.local`; no hosted project was changed.

## Results

| Check | Result |
| --- | --- |
| Full lint and type checking | Passed after changes |
| Existing automated tests | 133 passed, including production-build secret checks |
| Formatting | Passed |
| Opt-in live tests | 7 passed against real local Supabase |
| Five seeded demo accounts | All sign in through real Supabase Auth |
| Browser owner/admin/crew/Bravo/operator logins and sign-out | Passed |
| Owner Inbox | Purchase approve, test-request reject, task create/complete, approval request, and human escalation passed |
| Customers | Created local test customer and verified saved row |
| Jobs | Created customer-linked job and updated status; display regression found and fixed |
| Vendors | Created preferred local test vendor |
| Settings | Added test employee; verified memberships, retired rules, revoked grants, escalations, and audit entries |
| Browser permissions | Crew cannot decide approvals; admin sees owner-only financial/high-risk restrictions |
| Tenant isolation | Bravo browser shows only Bravo customer; real JWT/PostgREST queries are tenant-scoped; Acme cannot update Bravo jobs |
| Trusted DB assumptions | Tables owned by postgres; authenticated role switching and reset both work |
| Concurrent approvals | Three parallel real-connection requests produce one decision event and one decision audit; two requests replay |
| Approval protection | Crew service decision rejected; direct PostgREST approval write rejected |
| Delegation | Admin financial decision denied until scoped rule exists; test rule retired afterward |
| Operator access | No cases without grant; scoped grant enables audited access; revocation removes access; browser queue empty afterward |

## Changes made

- Added Supabase as a project development dependency and updated the lockfile.
- Added `packages/core/test/live-stack.test.ts`, explicitly enabled with `BO_LIVE_TEST=1`; ordinary tests skip it and remain Docker-independent.
- Fixed `apps/web/src/app/(tenant)/jobs/page.tsx`: key the status selector by the saved status so successful submission does not reset the dropdown to stale default data. Verified two successive browser updates, Active → Completed → Closed.
- Created local environment configuration and started the app and Supabase.
- Corrected local setup documentation to use the project-local CLI and prepared `docs/M2_READINESS.md`.
- Preserved existing uncommitted Claude implementation work; no commit or deployment was made. Next dev also generated its framework guidance files under `apps/web`.

## Repeat the checks (PowerShell, project root)

```powershell
pnpm exec supabase start
pnpm dev

# In a second terminal
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check

$env:BO_LIVE_TEST = '1'
pnpm --filter @backoffice/core exec vitest run test/live-stack.test.ts
Remove-Item Env:BO_LIVE_TEST
```

The live suite is for the seeded local stack only. It uses loopback URLs, creates labelled verification records, and retires its temporary delegation rules and revokes its operator grants. It expects the demo operator to have no pre-existing active grant and the admin to have no pre-existing purchase delegation. Audit history and test records are retained.

## Explore the app

Local demo owner: `owner@acme.test`, password `backoffice-dev-1`.

Other local accounts use the same demo password: `admin@acme.test`, `crew@acme.test`, `owner@bravo.test`, and `ops@backoffice.test`.

Test customer, vendor, employee, closed job, and escalation remain labelled `Live Browser Test ...`. The seeded $450 rock approval was approved. No purchase was placed: M1 records approval decisions and has no downstream purchasing consumer.

## Scope and limits

This is local development verification, not a production-readiness certification. New-account sign-up/onboarding and every possible settings combination were not exhaustively browser-tested. Operator grant/delegation transitions and concurrent decisions were exercised through the real domain services and database, not every corresponding browser control. Known limitations in `docs/M1_BUILD_REPORT.md` remain except the live-stack/authentication/concurrency gaps resolved above.

M2 preserves the managed-back-office direction and starts with voice/SMS adapters, verified idempotent webhooks, caller matching, receptionist tools, summaries, transfers, and human fallback. Provider selection and real phone setup remain to be decided; no paid service was activated.
