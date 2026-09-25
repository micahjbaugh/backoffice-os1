# Claude Code Task — Implement Milestone 1

## Objective

Build the Business Brain and Owner Inbox foundation.

Before writing code:
- read `CLAUDE.md`
- read all `/docs/*.md`
- inspect `supabase/migrations/0001_core.sql`
- write a short implementation plan into `docs/M1_IMPLEMENTATION_PLAN.md`
- then implement without asking for confirmation unless a destructive external action is required

## Required deliverables

### Project setup
- pnpm workspace
- Next.js + TypeScript app in `apps/web`
- lint
- formatting
- test framework
- environment example

### Supabase
- Supabase client setup
- auth
- migration application docs
- RLS policies
- RLS tests

### Domain
Implement repositories/services for:
- Organization
- Membership
- Customer
- Employee
- Vendor
- Job
- Task
- Approval
- BusinessRule
- BusinessEvent
- AuditLog
- OpsCase

### Owner Inbox
Routes/pages:
- `/inbox`
- `/customers`
- `/jobs`
- `/vendors`
- `/settings`

Inbox:
- pending approvals
- open high-priority tasks
- approve
- reject
- add note

### Internal Ops
- `/ops/cases`
- only internal authorized role
- tenant-scoped grant required to open tenant case

### Server actions/API
No client-side direct service-role usage.

Implement:
- create approval
- decide approval
- create task
- create event
- create audit log
- create ops case

### Tests
At minimum:
1. org A user cannot read org B customer
2. org A user cannot update org B job
3. field employee cannot approve owner's financial approval
4. deciding approval twice does not execute twice
5. approval decision creates business event
6. approval decision creates audit log
7. service-role-only secret never appears in browser bundle
8. internal operator cannot access tenant without scoped grant

## Completion gate

Run:
- lint
- typecheck
- tests

Update:
`docs/M1_BUILD_REPORT.md`

Include:
- what was implemented
- test results
- known limitations
- exact next command to run locally

Do not begin M2.
