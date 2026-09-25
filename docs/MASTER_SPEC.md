# Master Product & Technical Specification

## 1. Product thesis

Back Office OS is an **AI-powered managed back office for small service businesses**.

It is not primarily:
- field-service management software,
- bookkeeping software,
- a call-answering bot,
- procurement software,
- payroll software,
- or a CRM.

It coordinates those functions around a shared model of the business and takes operational work off the owner.

### North-star outcome

Reduce **Owner Administrative Minutes Per Week** while increasing:
1. billable work captured,
2. speed-to-invoice,
3. collections,
4. purchasing efficiency,
5. operational cleanliness,
6. tax/accountant readiness.

## 2. Initial ICP

Start with field-service businesses that typically have:
- 5–30 field employees,
- roughly $1M–$10M annual revenue,
- owner still deeply involved in daily operations,
- weak/overloaded office function,
- high phone/text volume,
- field work that produces labor/equipment/material billables.

Initial vertical cluster:
- excavation / dirt work,
- concrete,
- septic,
- fencing,
- landscaping,
- tree service,
- hauling,
- welding/fabrication,
- ag services,
- small construction / site work.

Do **not** optimize first for highly regulated medical/legal workflows or enterprise contractors.

## 3. Customer interaction model

### Owner
Primary:
- SMS
- phone
- Owner Inbox

Secondary:
- web/mobile dashboard for review and setup

### Field employees
Primary:
- SMS
- voice note
- photo
- optional simple time capture

### Customers
- contractor's existing phone number
- SMS
- email

### Suppliers
- phone
- email
- web/API where available

### Internal operations team
- Ops Console with exception queue, evidence, action history, and safe tools

## 4. Core product modules

### A. Front Office
- inbound AI receptionist
- overflow / after-hours / AI-first routing
- caller identification
- lead intake
- existing-customer lookup
- FAQ
- scheduling requests
- warm transfer
- post-call structured extraction
- automatic follow-up text
- human escalation

### B. Sales / Lead Management
- lead qualification
- estimate-site-visit scheduling
- draft scope intake
- estimate status
- automated follow-up
- stale lead alerts
- acceptance conversion to job

### C. Field Capture
- crew text parsing
- voice-note transcription + extraction
- photo attachment
- time entries
- equipment hours
- materials used
- daily job notes
- possible change order detection
- ambiguity questions

### D. Revenue Protection
- compare estimate/scope against actual job events
- identify unbilled labor/equipment/materials
- detect work after last invoice
- detect customer-requested additions
- create billable opportunity
- draft invoice / change order
- owner approval

### E. Procurement
- purchase request from owner/employee/job
- catalog/API lookups where available
- outbound voice supplier calls
- normalize availability, unit price, freight, pickup/delivery, lead time
- quote comparison
- purchasing rules
- approval threshold
- place approved order
- PO/order record
- receipt/bill matching
- job-cost assignment

### F. Accounts Receivable
- send invoice through accounting/payment provider
- due date tracking
- approved reminder cadence
- customer promise-to-pay capture
- disputes and escalation
- payment matching

### G. Accounts Payable
- vendor invoice ingestion
- OCR/extraction via provider
- PO/receipt/invoice match
- discrepancy detection
- job/category assignment
- payment approval queue
- export/sync to accounting

### H. Scheduling / Dispatch
- jobs
- crews
- equipment
- dependencies
- conflicts
- status
- weather/manual constraints later
- customer notification rules

### I. Time / Payroll Prep
- employee time
- job allocation
- overtime detection
- approval
- payroll-period close
- export/sync to payroll provider
- no payroll tax engine initially

### J. Tax-Ready / Accountant-Ready
- receipt retention
- W-9/vendor status
- asset/equipment purchase packet
- loan documents
- owner transaction flags
- mileage/vehicle record support
- accountant export/portal
- unresolved-bookkeeping queue
- no tax advice/elections

### K. Equipment / Fleet
- equipment registry
- VIN/serial
- ownership/financing
- internal cost rate
- billable rate
- hours/mileage
- job usage
- maintenance schedule
- service events
- documents

### L. Employee Office
- employee directory
- PTO request/status
- certification/document expiry
- simple employee questions
- payroll document links via provider
- benefits later

### M. Owner Inbox
One queue containing only exceptions and decisions.

Examples:
- approve invoice
- choose supplier
- approve overtime
- approve change order
- approve purchase
- resolve customer dispute
- resolve unmatched transaction

## 5. Core architecture rule: events, not screens

Every meaningful input becomes an immutable or append-only business event.

Examples:
- `call.received`
- `call.completed`
- `lead.created`
- `crew.update.received`
- `time.detected`
- `material.detected`
- `scope_change.detected`
- `purchase.requested`
- `vendor.quote.received`
- `approval.requested`
- `approval.decided`
- `invoice.draft_created`
- `payment.received`

Screens are projections over business data; workflows are reactions to events.

## 6. Business Brain

The Business Brain is the shared domain graph for a tenant.

It must model:
- organizations
- users/memberships
- employees
- customers
- contacts/locations
- leads
- jobs
- estimates/scopes
- job activities
- time entries
- equipment
- equipment usage
- materials
- vendors
- vendor quotes
- purchase requests
- purchases/orders
- receipts/bills
- invoices
- payments
- tasks
- approvals
- communications
- documents
- business rules
- integrations
- audit log
- events

## 7. Agent model

Agents are **specialized interfaces to deterministic tools**.

Agents do not directly mutate critical records or external systems.

Each agent:
1. receives context,
2. reasons/converses,
3. requests tool action,
4. server validates tenant, user, policy, schema, idempotency and authorization,
5. workflow executes or creates approval,
6. audit log records result.

Initial agents:
- Receptionist Agent
- Field Capture Agent
- Procurement Agent
- AR Agent
- Owner Assistant
- Internal Ops Assistant

Later:
- Sales Agent
- Dispatch Agent
- AP Agent
- Employee Agent

## 8. Autonomy / policy system

Every tool action has a risk class.

### GREEN — system may execute automatically
Examples:
- create draft lead
- attach communication
- create draft time entry
- send approved appointment reminder
- classify document
- request missing information
- create internal task

### YELLOW — requires configured approval unless tenant delegates it
Examples:
- send invoice
- purchase materials
- approve overtime
- issue credit/refund
- reschedule committed customer job
- contact customer regarding collections
- place supplier order

### RED — never autonomous in initial product
Examples:
- change bank destination
- run payroll without approved close
- terminate employee
- sign legal contract
- make tax election/advice
- materially alter employee pay
- significant capital purchase
- access/change credentials
- medical/benefit decision

Policies may further constrain:
- amount
- vendor
- job
- employee role
- time of day
- customer class
- specific action type

## 9. Human backstop

Every workflow can create an `ops_case`.

Reasons:
- confidence below threshold
- policy conflict
- missing required data
- integration failure
- caller requests human
- unusual financial decision
- external party dispute

Internal operator can:
- inspect evidence,
- contact parties,
- correct structured data,
- complete action,
- document outcome,
- mark automation-gap category.

Automation-gap categories feed product backlog.

## 10. Multi-tenancy

Every business record belongs to `organization_id`.

Rules:
- no cross-tenant queries in client code
- RLS enabled for exposed tenant tables
- privileged service operations are server-only
- membership-based authorization
- internal operators access tenants only through explicit scoped grants
- audit internal operator access

## 11. Communications

Store:
- channel
- direction
- participants
- timestamps
- provider IDs
- summary
- transcript/body where permitted
- structured extraction
- attachments
- related customer/job/vendor/lead
- retention policy status

Call audio/transcript retention must be configurable by jurisdiction and company policy.

## 12. Integration strategy

Use adapters.

### Voice
`VoiceProvider`
- createInboundRoute
- initiateOutboundCall
- transferCall
- sendSMS
- ingestWebhook

### Accounting
`AccountingProvider`
- syncCustomer
- syncVendor
- createDraftInvoice
- createBill
- fetchPayments
- fetchChartOfAccounts

### Payroll
`PayrollProvider`
- exportApprovedTime
- employeeDirectory
- payPeriodMetadata

### Payments
`PaymentProvider`
- createPaymentLink
- paymentStatus

### Calendar
`CalendarProvider`
- availability
- createEvent
- updateEvent

Do not spread provider-specific IDs throughout domain tables. Use integration-link tables.

## 13. Observability & audit

For every consequential action store:
- actor type: user / AI agent / internal operator / integration
- actor ID
- organization
- source event
- policy decision
- tool name
- sanitized input
- result
- external provider request ID
- approval ID if applicable
- timestamp

We need to answer:
**who/what did this, why, with whose approval, and what external system changed?**

## 14. AI data rules

LLMs can:
- classify
- extract
- summarize
- draft
- recommend
- request safe tools

LLMs cannot be the system of record.

Structured records are created through validated server tools.

Do not rely on prompt text for permission enforcement.

Sensitive actions require code-level authorization.

## 15. Confidence handling

AI outputs involving operational records include:
- extracted fields
- confidence per field
- evidence spans/messages
- unresolved questions

Low-confidence fields should remain draft and create clarification or ops work.

## 16. Owner Inbox design

Every inbox item contains:
- action title
- plain-language context
- dollars/time impact when known
- evidence
- recommended action
- alternatives
- approve/reject/modify
- expiry/deadline
- policy source

Avoid requiring owner to open the full application for common approvals. SMS deep links / secure short actions may come later.

## 17. Product metrics

Primary:
- owner admin hours eliminated

Financial:
- unbilled revenue identified
- invoice speed
- AR days improved
- dollars collected
- supplier savings
- duplicate/incorrect expense caught

Operational:
- calls answered
- leads captured
- lead-to-estimate speed
- field updates captured
- payroll exceptions
- decisions required per 100 events

Automation:
- autonomous completion rate
- human-touch rate
- error/reversal rate
- escalation reasons

## 18. Non-goals initially

- replace general ledger
- become bank
- become payroll tax processor
- become insurance carrier
- provide tax/legal advice
- autonomous high-value capital procurement
- bespoke full ERP
- support every service vertical from day one

## 19. First full-service customer promise

Customer may use:
- inbound receptionist
- crew text capture
- purchase price checks
- draft invoicing
- AR follow-up
- receipt organization
- payroll-ready time
- daily owner brief

Where software cannot reliably complete the job, internal operations finishes it.

## 20. Success test

The first meaningful proof is not app engagement.

For one real customer:
- owner admin time materially declines,
- response rate improves,
- invoices go out faster,
- missed billables are found,
- purchasing takes less owner time,
- office records become cleaner,
- customer is willing to keep paying four-figure monthly service fee.
