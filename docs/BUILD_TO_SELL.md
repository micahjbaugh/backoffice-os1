# Build to sell

Direction agreed 2026-09-27: build first, then sell. Nothing from the original design is dropped;
this changes the order so each stage is something a buyer can see and use.

**Pilot promise:** "Your crew texts what happened. We make sure the office work gets finished."
Human-assisted work (invoice preparation, follow-through) is stated as such. Nothing claims software
sent an invoice or updated accounting before those integrations exist and are authorized.

## Order

**Update (2026-09-27): the text invoice app is priority one.** After M3 and PH, the autopilot builds
SI1 → SI2 → SI3 → SI4 → SC → SI6 (launch) → SI5, then continues with VIS and the order below
(PH is already done by then). Product: [TEXT_INVOICE.md](TEXT_INVOICE.md). Build plan and scale rules:
[TEXT_INVOICE_BUILD.md](TEXT_INVOICE_BUILD.md).

| # | Milestone | Outcome a buyer can see |
|---|---|---|
| done | M1, M2 (code complete), M3 | Business Brain, AI receptionist, crew texts become draft records |
| 1 | **VIS** See it | Leads, conversations, crew, and one history page per job |
| 2 | **OPS** Operator follow-through | Every open item has an owner, next action, due date and evidence; "I'll handle this"; escalation; invoice-prep checklist |
| 3 | **OWN** Owner by text | Daily brief, decisions by text reply, Send back ([SEND_BACK.md](SEND_BACK.md)) |
| 4 | **CALL** Call routing | Ring a person first, after hours to the AI |
| 5 | **PH** Production hardening | Unchanged; required before any real customer data |
| 6 | **GO** Go-live | Setup checklist, onboarding rehearsal, sales demo, pilot metrics |
| 7 | M4 → M10 | Invoicing + QuickBooks, purchasing (with price matching and vendor counters), AR/AP, payroll prep, scheduling, tax-ready, analytics |

The owner brief moved from M10 to OWN; M10 adds its metrics to that brief.

## Rules for every new milestone

- An **acceptance suite through the running app** (production build, real session gate, signed
  webhooks where relevant, local Supabase) covering failure, retry, ambiguity and handoff cases.
- A **walkthrough by a person**, deferred so building continues, but the milestone is not accepted
  without it.
- Passing component tests or task counts never count as customer-ready.

## Defaults (all configurable)

- Quiet hours 8pm–6am local, except urgent items.
- Owner brief at 6:30am local.
- Red-risk or over-limit decisions open a signed link, never a bare text reply.
- Send-backs expire after 3 days (or the quote's expiry, if sooner).
- Operator coverage hours and response targets are blank until the business sets them.

## Decisions only the owner can make

- Hosting, the hosted Supabase plan, MFA and backups (PH-T05, PH-T06).
- Twilio and Vapi accounts, a business number registered with carriers for texting, and the live
  phone check (M2-T17).
- Who staffs operations, coverage hours and response targets.
- Pricing, terms of service, and liability for AI-assisted purchases.
- Repository visibility (public now; make it private before the first sales conversation).
