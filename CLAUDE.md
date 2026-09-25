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

See `.claude/IMPLEMENT_M1.md`.
