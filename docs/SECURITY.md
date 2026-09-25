# Security, Authorization & Audit

## Principle

The system may eventually control phones, invoices, payroll inputs, purchases, and customer communications. Security architecture is a product feature, not a later cleanup.

## 1. Tenant isolation

Every tenant-owned row includes `organization_id`.

Enable Postgres RLS on every exposed tenant table.

Browser/client access:
- authenticated user
- membership determines organization
- policies restrict rows to memberships

Server service key:
- server-only
- never browser
- every privileged service method explicitly receives `organization_id`
- domain authorization check before access

## 2. Roles

Initial tenant roles:
- Owner
- OfficeAdmin
- Manager
- FieldEmployee
- AccountantReadOnly

Internal:
- OpsAgent
- OpsSupervisor
- PlatformAdmin

Internal access must be scoped and audited.

## 3. Sensitive tool calls

Never allow an AI to use raw provider credentials.

AI requests a named domain tool:
`create_purchase_approval`, not `POST arbitrary_url`.

Server validates:
- tenant
- caller identity
- tool schema
- action policy
- dollar limits
- role
- entity state
- idempotency
- approval

## 4. Authentication

- MFA available for owners/admins
- short session lifetime for privileged interfaces
- re-authentication for especially sensitive settings
- no shared staff logins

## 5. Secrets

- environment secret manager
- provider tokens server-side
- rotate
- least scopes
- no secrets in prompts/logs

## 6. Audit

Append-only audit event for:
- record mutations
- approvals
- external side effects
- role/permission changes
- integration connection changes
- internal operator access
- file download/view for sensitive classes when feasible

## 7. Call recording/transcripts

Recording/transcription behavior must be configurable.

Store consent/disclosure configuration per organization/jurisdiction.

Default product experience should clearly identify AI/automated assistant where appropriate.

## 8. Financial controls

Never:
- change destination bank account based only on email/text
- execute large purchase without policy
- run payroll based on unapproved AI extraction
- issue material refund/credit outside authority

Require two-step verification for:
- banking changes
- payroll connection changes
- owner/role changes

## 9. Data classes

Suggested:
- Public
- Internal
- Confidential
- Financial
- EmployeeSensitive
- Credential/Secret

Use class to guide logging/redaction/retention.

## 10. AI logging

Do not store unnecessary sensitive raw content in model-observability logs.

Use redacted/sanitized logs for debugging.

## 11. Backups / recovery

Before production:
- automated Postgres backups
- object storage durability
- restore drill
- provider webhook replay strategy
