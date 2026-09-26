/** Canonical business event types emitted in M1 (MASTER_SPEC §5). */
export const EVENT_TYPES = {
  organizationCreated: "organization.created",
  memberAdded: "membership.created",
  customerCreated: "customer.created",
  employeeCreated: "employee.created",
  vendorCreated: "vendor.created",
  jobCreated: "job.created",
  jobUpdated: "job.updated",
  taskCreated: "task.created",
  taskStatusChanged: "task.status_changed",
  approvalRequested: "approval.requested",
  approvalDecided: "approval.decided",
  noteAdded: "note.added",
  ruleVersionCreated: "business_rule.version_created",
  ruleRetired: "business_rule.retired",
  opsCaseCreated: "ops_case.created",
  opsCaseUpdated: "ops_case.updated",
  documentRegistered: "document.registered",
  communicationRecorded: "communication.recorded",
  communicationUpdated: "communication.updated",
  communicationTransferred: "communication.transferred",
  callDispositionRecorded: "communication.disposition_recorded",
  leadCreated: "lead.created",
  timeEntryDrafted: "time_entry.drafted",
  equipmentUsageDrafted: "equipment_usage.drafted",
  materialUsageDrafted: "material_usage.drafted",
  jobNoteDrafted: "job_note.drafted",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** Deterministic idempotency key for the single `approval.decided` event of an approval. */
export function approvalDecidedIdempotencyKey(approvalId: string): string {
  return `approval.decided:${approvalId}`;
}
