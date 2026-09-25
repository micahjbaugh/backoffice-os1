# Build Milestones

## Rule

The customer-facing service may be broad. Engineering is still sequential.

Do not start the next milestone until acceptance criteria for the current milestone pass.

---

# M1 — Business Brain + Owner Inbox Foundation

## Scope
- monorepo
- Supabase project wiring
- auth
- organization + membership
- customer
- employee
- vendor
- job
- task
- approval
- business event
- audit log
- business rules
- document metadata
- internal ops case
- Owner Inbox UI
- Ops Queue UI

## Acceptance
- user belongs to org A and cannot access org B data
- owner creates customer/job/vendor
- server can create approval
- owner can approve/reject
- every decision produces audit record and business event
- internal operator can access a tenant only via explicit grant
- database RLS tests exist

---

# M2 — Communications Core

## Scope
- SMS provider adapter
- voice provider adapter
- communication record
- webhook receipt/idempotency
- customer/caller matching
- transcript + summary
- inbound receptionist agent
- transfer tool
- create lead tool
- create callback/task tool
- call disposition

## Acceptance
- call business number
- agent identifies company
- qualifies fake lead
- safely looks up permitted business info
- creates lead and call summary
- warm transfer works
- duplicate webhook does not duplicate lead
- all calls/actions auditable

---

# M3 — Field Capture

## Scope
- employee phone identity
- crew SMS/voice intake
- job matching
- time draft
- equipment usage draft
- material usage
- job note
- scope-change detection
- clarification workflow

## Acceptance
Input:
"Me Jake Tyler 7-5:30 Wilson. Hoe 8 hrs D6 6.5, 21 ton rock. Customer had us grade another 200 ft."

Output:
- three draft time entries
- equipment usages
- material usage
- job note
- billable opportunity
- owner sees only necessary approval/clarification

---

# M4 — Revenue Protection + Invoicing

## Scope
- estimates/scopes
- billable opportunities
- invoice drafts
- accounting provider interface
- QuickBooks adapter
- invoice approval
- unbilled-work detector

## Acceptance
- completed job activity can create invoice draft
- line items trace back to evidence
- owner approval required
- approved invoice syncs to sandbox accounting provider
- external IDs stored in integration links
- repeated sync is idempotent

---

# M5 — Procurement Voice Agent

## Scope
- purchase request
- items/specifications
- vendor selection
- outbound call workflow
- quote extraction
- quote normalization
- comparison
- approval rules
- order callback workflow

## Acceptance
- owner submits natural-language purchase request
- system calls at least two test vendors/numbers
- normalized quotes returned
- no substitution/spec change without rule/approval
- approval creates order
- complete audit trail

---

# M6 — AR / AP

## Scope
- AR reminders
- promise-to-pay
- invoice status
- vendor bills
- receipts
- PO/bill/receipt match
- discrepancy approval

---

# M7 — Time Close + Payroll Prep

## Scope
- pay period
- overtime
- approval
- payroll export adapter
- missing time detection

---

# M8 — Scheduling / Dispatch

## Scope
- crew availability
- job dependencies
- equipment conflicts
- schedule
- customer updates

---

# M9 — Tax Ready + Accountant Portal

## Scope
- reconciliation status
- W-9 tracking
- asset packet
- missing receipt queue
- accountant role
- year-end packet

---

# M10 — Analytics / Owner Assistant

## Scope
- natural-language analytics using validated query layer
- profitability
- unbilled work
- vendor spend
- AR
- overtime
- equipment economics
