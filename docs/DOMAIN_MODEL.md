# Domain Model

## Organization / identity
- Organization
- User
- Membership
- Role
- InternalOperatorGrant

## People
- Employee
- Customer
- CustomerContact
- Vendor
- VendorContact

## Places
- Address
- CustomerProperty
- JobSite

## Sales
- Lead
- LeadActivity
- Estimate
- EstimateLine
- ScopeItem

## Jobs
- Job
- JobActivity
- JobAssignment
- JobStatusHistory
- BillableOpportunity
- ChangeRequest

## Workforce
- TimeEntry
- TimeApproval
- PTORequest
- Certification

## Equipment
- Equipment
- EquipmentUsage
- MaintenancePlan
- MaintenanceEvent

## Procurement
- PurchaseRequest
- PurchaseRequestItem
- VendorQuote
- VendorQuoteItem
- PurchaseOrder
- PurchaseOrderItem
- Delivery

## Finance
- Invoice
- InvoiceLine
- Payment
- VendorBill
- Receipt
- Expense
- AccountingSync

## Communications
- Communication
- Call
- Message
- Email
- CommunicationParticipant

## Workflow / control
- Task
- Approval
- ApprovalDecision
- BusinessRule
- OpsCase
- BusinessEvent
- AuditLog

## Files
- Document
- DocumentLink

## Integration
- IntegrationConnection
- ExternalObjectLink
- WebhookReceipt

## Key lifecycle examples

### Lead
`new -> qualified -> estimate_scheduled -> estimated -> won/lost`

### Job
`draft -> scheduled -> active -> paused -> completed -> invoiced -> closed`

### PurchaseRequest
`draft -> sourcing -> quoted -> awaiting_approval -> approved -> ordered -> fulfilled -> closed`

### Approval
`pending -> approved/rejected/expired/cancelled`

### OpsCase
`new -> assigned -> waiting_external -> resolved -> closed`
