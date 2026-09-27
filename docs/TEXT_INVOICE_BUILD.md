# Text invoice app: coding plan

*Draft, 2026-09-27. For the autopilot builder (Claude) and reviewer (ChatGPT) on micahjbaugh/backoffice-os1. Priority one: loaded into `workflow/blueprint.json` through a plan PR, with the autopilot paused while it merges. Product plan: `TEXT_INVOICE.md`.*

## 1. Where it fits

**Priority one (Micah, 2026-09-27).** Demand is taken as given; there is no ad-test gate.

**Order:** finish M3 (M3-T19) → **PH** production hardening → **SI1 → SI2 → SI3 → SI4 → SC → SI6** (launch) → **SI5** (business number add-on) → VIS, OPS, OWN, CALL, GO, M4 … M10.

- **PH comes first** because this product holds real customer data and real money from day one.
- **Designed for 100,000 paying customers.** SC (scale) is a full milestone before launch, and every SI task follows the scale rules in section 2b.
- **Shared work moves forward, not sideways.** Invoices, the unbilled-work nudge, payments, reminders and promise-to-pay are pulled from M4 and M6. Those M4/M6 tasks later extend what SI built, never rebuild it.
- **SI5** reuses the receptionist runtime (M2); it is written so CALL can later extend it for Back Office OS.

## 2. Architecture decisions (binding for every task)

1. **Same monorepo, same database, same app.** A solo tradesperson is an `organization` with `edition = 'solo'` and one owner membership. All CLAUDE.md rules apply unchanged: `organization_id` on every tenant row, RLS on every exposed table, audit log on every consequential action.
2. **The text conversation is the UI.** Web pages are limited to: signup, the public invoice/pay page, payout setup redirect, and a small settings page. Routes: `/start`, `/i/[token]`, `/api/webhooks/payments`, `/api/webhooks/email` (if needed). Public paths are added to `proxy.ts` explicitly, and each authenticates itself (token or signature) and fails closed, like the existing webhooks.
3. **Provider SDKs stay in adapters** (`packages/integrations`), each with an interface, a fake and a fixture test:
   `PaymentsProvider` (Stripe Connect Express), `EmailProvider`, `TranscriptionProvider` (voice memos), `VisionExtractor` (receipt and work-order photos), `NumberProvider` (search, buy, release, carrier registration). `SmsProvider` gains inbound media (MMS) and outbound media URLs.
4. **The AI proposes; code decides.** The LLM only turns text into structured drafts through the existing extraction contract and fact validator. It never sends anything, never sets an amount the tradesperson did not state or confirm, never marks anything paid, and never negotiates. Money states change only from signed payment webhooks or an explicit "paid cash" command with confirmation.
5. **Nothing reaches a customer without a YES**, except reminders and review asks the tradesperson turned on once in settings. YES is an approval record (existing approvals service) bound to a specific invoice revision. A second YES or a replayed webhook is a no-op.
6. **Every side effect goes through the outbox** (`outbound_operations`) with an idempotency key: texts, emails, payment links, number purchases, registration submissions.
7. **Never guess.** Two matching customers, a missing amount, an unclear line, an unknown command: ask a clarifying question by text. Unanswered clarifications show in the weekly summary. There is no operator in this edition; the tradesperson is the escalation path, and `ops` can see a solo tenant only through the existing explicit-grant mechanism.
8. **Public invoice pages** use an unguessable token (≥128 bits), show only that invoice, are rate-limited, carry no session, and expire or can be revoked. No customer list, no other invoices.
9. **Money is integer cents.** Fee and tax math live in `packages/domain`, pure and unit-tested, including rounding.
10. **Background work** runs from the existing jobs endpoint (`runBackgroundJobs`): reminders, daily nudges, subscription checks. Every step is safe to re-run and to run concurrently.

## 2b. Scale rules: built for 100,000 paying customers

Design target (per month): 100,000 tenants, about 15 million texts in and out, 3 million invoices, a daily nudge burst of 100,000 texts, 20 million LLM calls. Every task is written against these numbers.

1. **No per-tenant scans.** Scheduled work (reminders, nudges, summaries) is stored as due-time rows with an index on `(due_at, status)`, claimed in batches with `FOR UPDATE SKIP LOCKED`. Nothing loops over all organizations.
2. **Queue, not cron.** Background work runs from a durable Postgres queue with parallel workers and per-tenant fairness (one noisy tenant can't starve others). The existing jobs endpoint becomes a worker trigger.
3. **Ingest fast, process later.** Webhooks store and acknowledge in milliseconds (the existing ingestion table) and are processed by workers. Target: 500 inbound webhooks/second without loss.
4. **Sending capacity is a pool.** Outbound texts go through a sender pool (toll-free numbers now, a short code when approved) with per-sender throughput limits, sticky sender per customer, and backoff on provider rate limits. Bursts (the 6pm nudge) are spread over a window.
5. **LLM last, not first.** A deterministic fast-path parser handles common shapes ("Invoice Wilson $450 gutters") without a model call. Model calls have concurrency limits, retry with backoff, a fallback model, per-tenant daily caps and cost metering.
6. **Every query is tenant-scoped and indexed.** `organization_id` leads every index on hot tables. High-volume tables (messages, audit, events) have a retention and partitioning plan. Connections go through the pooler.
7. **Spend guards.** Per-tenant and global caps for texts, calls and model spend, with alerts before and a hard stop at the cap.
8. **No human in the signup path.** Signup, payout setup, number setup, help and billing all work with zero staff. Humans handle only escalations.

## 3. Milestones and tasks

Format matches the blueprint: each milestone has acceptance criteria, an acceptance suite run through the running app (`acceptance_live_stack: true`), and a deferred walkthrough by a person. Keep each task within the step-size rule (≤150 lines per file per step, hard limit 200).

### SI1: Solo accounts and the text front door
*Requires PH (automated). Acceptance: a new phone number can sign up by text, verify, and set a business name; a second org cannot see the first; STOP/HELP work; an unknown message gets a clarifying reply, never a guess.*

| Task | Title | What | Done when |
|---|---|---|---|
| SI1-T00 | Edition flag | Migration: `organizations.edition` (`office`\|`solo`, default `office`), plus solo settings table (business name, logo document id, reminder time, time zone, markup %, review link). RLS. | Migration + RLS isolation tests pass. |
| SI1-T01 | Self-serve signup | `/start` form and "START" by text. One-time code by SMS, creates org + owner membership. Idempotent per phone; rate-limited (PH-T01). | Duplicate START doesn't create two orgs; code expiry and retry tests. |
| SI1-T02 | MMS in and out | Extend `SmsProvider` for inbound media and outbound media URLs; Twilio adapter + fake; media stored in private storage (PH-T03). | Fixture tests for Twilio media webhooks; stored media is org-scoped. |
| SI1-T03 | Solo command router | Inbound SMS from a solo owner's phone → structured intent (invoice, customer, question, settings, stop, unknown) via the extraction contract. Unknown → clarification. | Table-driven tests for 30+ sample texts; unknown never becomes an action. |
| SI1-T04 | Business profile by text | Business name, logo photo, time zone, reminder time, markup % through the router, with confirmations. | Each setting has a confirm/undo test. |
| SI1-T05 | Texting compliance | Opt-in record at signup, STOP/START/HELP, quiet hours (8pm to 6am local unless the owner asked), message templates with business identification. | STOP blocks all outbound to that number; tests per keyword. |
| SI1-T06 | SI1 acceptance suite | Running app, signed webhooks, local Supabase: signup, isolation, compliance, clarification. | Suite passes in CI. |
| SI1-T07 | SI1 walkthrough by a person | Micah signs up from his own phone against staging. | Deferred human check. |

### SI2: Invoices by text
*Requires SI1. Acceptance: "Invoice Ann Wilson 555-123-4567, water heater swap, $450" produces a correct preview; YES sends exactly once; tap-to-send link and email both work; ambiguity produces a question; a public invoice link shows only that invoice.*

| Task | Title | What | Done when |
|---|---|---|---|
| SI2-T00 | Migration: invoices | `invoices`, `invoice_lines`, `invoice_revisions`, per-org numbering, public token, status (`draft`, `sent`, `partially_paid`, `paid`, `void`). Shared with M4-T02. RLS, idempotency keys. | Isolation + numbering concurrency tests. |
| SI2-T01 | Customer capture | Name/phone/email from text; vCard (shared contact) parser; photo of a work order via `VisionExtractor` (interface + fake). Matching reuses entities/caller-matching; two candidates → clarification. | vCard fixtures; "two Wilsons" asks; never merges customers silently. |
| SI2-T02 | Invoice draft from text | Extraction contract for invoice lines; missing amount or customer → ask. Voice memo via `TranscriptionProvider` (interface + fake, then adapter). | 25+ sample texts incl. voice transcripts; no invented amounts. |
| SI2-T03 | Parts receipt photo | `VisionExtractor` adapter (Anthropic) reads a receipt into parts lines; markup % applied in domain code; tradesperson confirms. | Fixture receipts; markup rounding tests; low confidence asks. |
| SI2-T04 | Preview and YES | Preview text with total and customer; YES creates an approval bound to the revision; "change X" creates a new revision; double YES is a no-op. | Idempotency and stale-revision tests (YES to an old preview is refused). |
| SI2-T05 | Public invoice page | `/i/[token]`: branded, mobile-first, invoice only. Pay button disabled until SI3. Rate-limited, revocable. | Token-guessing, cross-org and revoked-token tests; no session required or accepted. |
| SI2-T06 | Delivery | Tap-to-send: `sms:` link with the customer number and prefilled note, returned to the tradesperson. `EmailProvider` interface + fake + adapter (Postmark or Resend; pick one, document it). Sends via the outbox. | Outbox retry/ambiguity tests; email bounce recorded. |
| SI2-T07 | SI2 acceptance suite | Running app end to end. | Suite passes. |
| SI2-T08 | SI2 walkthrough by a person | Micah invoices himself three ways (text, voice memo, receipt photo). | Deferred human check. |

### SI3: Get paid
*Requires SI2. Acceptance: a connected account can be onboarded; a customer pays by card and by bank; the invoice becomes paid exactly once from the signed webhook; fees are exact; the tradesperson is told; subscription trial and failed payment behave.*

| Task | Title | What | Done when |
|---|---|---|---|
| SI3-T00 | PaymentsProvider contract + fake | Connected-account onboarding link, checkout/payment link with application fee, refunds, webhook verification. | Contract tests run against the fake. |
| SI3-T01 | Stripe Connect Express adapter | Adapter only; SDK stays here. Test mode fixtures. | Signed-webhook fixture tests; bad signature → 401. |
| SI3-T02 | Payout setup by text | "Set up payouts" returns an onboarding link; status tracked from webhooks; invoices before payout setup say "pay by check or cash." | Status transitions tested from fixtures. |
| SI3-T03 | Fee rules | Domain: the advertised all-in rate (card 3.5% + 30¢, bank 1%) and our application fee (the all-in rate minus Stripe's own fee, about 0.6% on cards) are settings, not constants. Stripe's fee is charged to the connected account. Integer cents, rounding tests. | Property tests on fee math. |
| SI3-T04 | Migration + payment webhooks | `payments` (shared with M6-T00). Webhook → payment record → invoice status; duplicate and out-of-order events safe; notify tradesperson "Ann Wilson paid $450." | Replay, reorder and partial-payment tests. |
| SI3-T05 | Paid cash, void, refund by text | "Wilson paid cash" and "void 1042" with confirmation; refunds only through the provider and with confirmation. Audit on each. | Each command's confirm and audit tests. |
| SI3-T06 | Subscription billing | $29/month, 14-day trial, card update link, failed payment → grace → pause sending (never delete data). Add-on line item hook for SI5. | Trial/grace/pause state machine tests. |
| SI3-T07 | SI3 acceptance suite | Running app with the fake provider; Stripe test-mode fixtures. | Suite passes. |
| SI3-T08 | SI3 walkthrough by a person | A real Stripe test-mode payment from a phone. | Deferred human check. |

### SI4: Beat Square (launch set)
*Requires SI3. Acceptance: the daily nudge turns a one-line reply into an invoice draft; reminders go at 3/7/14 days and stop on payment or request; a customer's "Can I pay Friday?" becomes a promise with a Friday reminder; disputes go to the tradesperson; one review ask per paid customer; "Who owes me?" is accurate.*

| Task | Title | What | Done when |
|---|---|---|---|
| SI4-T00 | Daily "anything to bill?" | Job at the tenant's local reminder time, quiet hours respected, skipped on days with an invoice already sent (setting). Reply goes through SI2 drafting. Shared with M4-T04. | Time zone, quiet-hours and skip tests. |
| SI4-T01 | Reminder cadence | 3/7/14 days (settings), per-customer and per-invoice stop, stops on payment/void. Via outbox. Shared with M6-T02/T03. | Cadence and stop tests; no reminder after paid, even with a late job run. |
| SI4-T02 | Customer reply handling | Replies to our number or email only. Classify: promise to pay (date) → schedule; "already paid" or dispute → forward to tradesperson, pause reminders; other → forward. The AI never argues, discounts or agrees to terms. Shared with M6-T04/T05. | 30+ reply samples; disputes always forwarded. |
| SI4-T03 | Review ask | After payment, once per customer, only if a review link is set and no dispute. | Once-only and suppression tests. |
| SI4-T04 | Questions by text | "Who owes me?", "What did I make in May?", "Resend Wilson's invoice" through a fixed query layer (no free-form SQL from the model). | Correct totals across time zones and partial payments. |
| SI4-T05 | Weekly summary | Sunday text: billed, paid, owed, open questions. | Content and empty-week tests. |
| SI4-T06 | SI4 acceptance suite | Running app, simulated clock. | Suite passes. |
| SI4-T07 | SI4 walkthrough by a person | A week of Micah's test business, compressed. | Deferred human check. |

### SC: Scale to 100,000 customers
*Requires SI4. Acceptance: a load test with 100,000 simulated tenants sustains the design target; the 6pm nudge burst completes within its window without provider rate-limit failures; webhook ingestion holds 500/second with no loss; model outages fall back or queue without losing messages; spend caps stop sending at the cap.*

| Task | Title | What | Done when |
|---|---|---|---|
| SC-T00 | Durable work queue | Postgres queue (claim with SKIP LOCKED, visibility timeout, retries, dead-letter), per-tenant fairness; move webhook processing, outbox dispatch and scheduled work onto it. | Concurrency, crash-recovery and fairness tests. |
| SC-T01 | Scheduled work as due-time rows | Reminders, nudges and summaries become indexed due-time rows; no per-tenant scans. | Query plans checked in tests; 100k-tenant fixture runs in bounded time. |
| SC-T02 | Sender pool | Pool of sending numbers with per-sender throughput, sticky assignment per customer, provider rate-limit backoff, burst spreading. Short code slots in as a pool member. | Throughput and backoff tests against the fake provider. |
| SC-T03 | Model capacity | Fast-path parser for common shapes; concurrency limits, backoff, fallback model, per-tenant caps, cost metering. | Fast path covers the top sample shapes; outage test queues instead of failing. |
| SC-T04 | Database scale | Indexes led by `organization_id` on hot tables; retention jobs; partitioning plan for messages/audit/events; pooler settings documented. | Migration + index tests; EXPLAIN checks for hot queries. |
| SC-T05 | Spend guards | Per-tenant and global caps for SMS, voice and model spend; alerts at 80%; hard stop at cap. | Cap and alert tests. |
| SC-T06 | Load test harness | Script that seeds 100,000 tenants and replays a month's traffic shape against a staging stack; reports throughput, latency, errors and cost. | Harness runs locally at 1/100 scale in CI; full run documented. |
| SC-T07 | SC acceptance suite | Automated checks for the acceptance list (reduced scale in CI). | Suite passes. |
| SC-T08 | SC full-scale run by a person | Micah (or Claude with him) runs the full 100k load test against staging and records results. | Deferred human check. |

### SI6: Launch readiness
*Requires SC. Acceptance: funnel metrics recorded; abuse limits enforced; terms accepted at signup; help by text works; founding-customer pricing applies.*

| Task | Title | What | Done when |
|---|---|---|---|
| SI6-T00 | Funnel metrics | Events: signup, verified, first invoice sent, payouts set up, first payment, week-4 active. Ops-only dashboard. | Events emitted once each; no customer PII in metrics. |
| SI6-T01 | Abuse and fraud limits | New-account send limits, unusual-amount holds, account freeze by ops, phishing-pattern check on invoice text. | Limit and freeze tests; frozen account can't send. |
| SI6-T02 | Terms and consent | Terms/privacy acceptance at signup (text supplied by Micah), versioned; payments terms via Stripe. | Consent recorded with version. |
| SI6-T03 | Help by text | "HELP"/"how do I…" answered from a fixed FAQ; anything else → "We'll email you" and an ops case. | FAQ coverage tests; unknown → ops case. |
| SI6-T04 | Founding pricing and referrals | Founding-customer price, referral codes ("give a month, get a month"), "Sent with [name]" footer on invoice pages (owner can turn off on paid plan). | Discount and referral credit tests; no double credit. |
| SI6-T05 | Launch acceptance suite | Signup to first payment through the running app. | Suite passes. |
| SI6-T06 | Launch walkthrough by a person | Micah onboards one real founding customer. | Deferred human check. |

### SI5: Business number add-on (after launch)
*Requires SI6 and M2 (automated). Acceptance: a number can be bought and released; registration status is tracked and sending falls back to tap-to-send while pending; calls ring the owner with a whisper and fall back to missed-call text-back; relayed texts reach the right customer; "call Ann" bridges; minutes are metered.*

| Task | Title | What | Done when |
|---|---|---|---|
| SI5-T00 | NumberProvider contract + fake | Search, buy, release, registration submit/status. | Contract tests. |
| SI5-T01 | Twilio number adapter | Adapter only. | Fixture tests. |
| SI5-T02 | Registration workflow | State machine (collect details → submitted → approved/rejected); status by text; fallback sending while pending. | Each state and rejection path tested. |
| SI5-T03 | Ring owner, then missed-call text-back | Whisper, ring timeout, missed-call SMS, receptionist runtime gathers details, summary to owner. Written so CALL-T00/T01 extend it. | Timeout and failed-ring fallback tests. |
| SI5-T04 | Two-way text relay | Customer texts forwarded to owner with name; owner's reply relayed to the right customer ("reply to latest" plus "to Ann: …"); ambiguous → ask. | Multi-conversation and ambiguity tests. |
| SI5-T05 | "Call Ann" bridge | Ring owner, then connect customer with business caller ID. | Bridge and failure tests. |
| SI5-T06 | Add-on billing and metering | $15 with 300 minutes; usage metering; 80% and 100% alerts; no silent overage charges. | Metering and alert tests. |
| SI5-T07 | SI5 acceptance suite | Running app with fakes. | Suite passes. |
| SI5-T08 | SI5 walkthrough by a person | A real number, a real missed call. | Deferred human check. |

### Later (not scheduled)
Price memory and underpricing flag; repeat-work prompts; tax set-aside and quarterly reminders; estimates to invoices; recurring invoices; deposits; year-end export.

## 4. Rules for the builder (Claude)

- Follow the Back-Office Automation Protocol in CLAUDE.md: read state first, one task per run, hand off in `workflow/state.json` only.
- Every new table: RLS policy plus an isolation test with two orgs.
- Every side effect: an idempotency test (replay, double YES, duplicate webhook, job re-run).
- Every AI-parsed input: table-driven tests with real-looking messy texts, including ones that must produce a question instead of an action.
- New provider: interface in `packages/integrations/src/providers`, fake in `fakes`, adapter in `adapters`, fixture test. No SDK import outside the adapter.
- Don't touch `workflow/` (except state.json), `.github/`, CLAUDE.md or check scripts.

## 5. Checklist for the reviewer (ChatGPT)

For every task diff, reject if any answer is no:
1. Does every new tenant table have `organization_id`, RLS, and a cross-org test?
2. Can anything reach a customer without an approval bound to the current revision (or a setting the owner turned on)?
3. Is every external call behind the outbox or an adapter, with an idempotency key?
4. Could the model's output change money, status or recipients without code-level validation?
5. Is every ambiguous input answered with a question rather than a guess, and is there a test for it?
6. Is money in integer cents with tested rounding?
7. Do public routes authenticate themselves and fail closed?
8. Is the audit log written for every consequential action?
9. Does the task stay inside its scope and the step-size rule?
10. Does it follow the scale rules (no per-tenant scans, queued work, indexed tenant-scoped queries, LLM fast path, spend guards)?

## 6. Human checks Micah owns

Walkthroughs SI1-T07, SI2-T08, SI3-T08, SI4-T07, SC-T08, SI6-T06, SI5-T08; plus the accounts and business decisions in Micah's launch steps (kept outside the repo). A milestone isn't accepted until its walkthrough is done.
