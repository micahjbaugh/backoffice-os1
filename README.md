# Back Office OS — Starter Repository

**Working promise:** *You run the work. We run the office.*

Back Office OS is a managed AI operating layer for small field-service businesses. The owner and crew should be able to keep working through phone calls, texts, voice notes, photos, and occasional approvals while the system turns those communications into structured business operations.

## Customer-facing capabilities

- AI receptionist / call overflow
- Lead capture and qualification
- Estimate follow-up
- Crew text/voice/photo intake
- Time and equipment-hour capture
- Change-order / unbilled-work detection
- Draft invoicing and AR follow-up
- Supplier voice-calling and price comparison
- Purchase approvals and PO preparation
- Receipt/AP capture
- Scheduling/dispatch assistance
- Payroll-ready time
- Tax-ready records
- Owner Inbox / morning brief
- Human backstop for exceptions

## Product principle

The customer is buying **completion**, not "AI."

If automation is uncertain, the workflow escalates to an internal operator. The customer should not have to care whether a task was completed by software, AI, or a human.

## Initial stack

- TypeScript monorepo
- Next.js web app for Owner Inbox + internal Ops Console
- Postgres/Supabase for database, auth, storage, RLS
- Voice provider adapter (Vapi first; Twilio number/telephony supported)
- LLM provider abstraction (do not hard-code one model vendor)
- QuickBooks Online integration adapter
- Payroll adapter layer (export first, embedded provider later)
- Background workflow/queue abstraction
- Object storage for receipts, images, documents, call artifacts

## Repository map

- `docs/MASTER_SPEC.md` — source of truth for the product
- `docs/ARCHITECTURE.md` — services, boundaries, events, workflow rules
- `docs/DOMAIN_MODEL.md` — entities and lifecycle
- `docs/SECURITY.md` — tenant isolation, permissions, audit, sensitive actions
- `docs/MILESTONES.md` — build order and acceptance gates
- `docs/FIRST_CUSTOMER_PLAYBOOK.md` — onboarding + operations
- `docs/M1_IMPLEMENTATION_PLAN.md` / `docs/M1_BUILD_REPORT.md` — M1 plan and build report (how to run locally)
- `supabase/migrations/` — `0001_core.sql` initial schema, `0002_m1_foundation.sql` M1 security foundation
- `supabase/README.md` — applying migrations, access model
- `apps/web/` — Next.js Owner Inbox + Ops Console
- `packages/domain/` — shared domain types, permission matrix, approval policy, validation
- `packages/core/` — Business Brain services/repositories (server-only) + RLS/authorization tests
- `packages/agents/` — agent definitions and tool contracts *(from M2)*
- `packages/integrations/` — provider adapters *(from M2)*
- `packages/workflows/` — deterministic workflows *(from M2)*
- `.claude/IMPLEMENT_M1.md` — first implementation brief for Claude Code
- `CLAUDE.md` — repository rules for Claude Code

## Current status

See `START_HERE.md` (where the project is and how to run it), `workflow/STATUS.md` on the
`autopilot` branch (live progress by verification level), `docs/REPAIR_REPORT.md` (the 2026-09
foundation repair) and `docs/PRODUCTION_HARDENING.md` (what must happen before production).

The original principle still holds: every call must have somewhere safe and structured to land
before the receptionist is built on top of it.
