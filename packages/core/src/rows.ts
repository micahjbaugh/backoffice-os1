// snake_case row -> camelCase domain mapping. Drivers differ on timestamp/int8 representation,
// so normalize here rather than trusting either.

import type {
  BillableOpportunity,
  Approval,
  AuditLogEntry,
  BusinessEvent,
  BusinessRule,
  Call,
  Communication,
  CommunicationParticipant,
  Customer,
  DocumentMetadata,
  Employee,
  EquipmentUsage,
  Job,
  JobNote,
  Lead,
  MaterialUsage,
  Membership,
  Message,
  Note,
  OperatorGrant,
  OpsCase,
  Organization,
  Task,
  TimeEntry,
  Vendor,
} from "@backoffice/domain";

export type Row = Record<string, unknown>;

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError(`expected timestamp, got ${typeof value}`);
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A SQL `date` column as "YYYY-MM-DD". Adapters must return dates as text (see the SqlExecutor
 * contract in ./db/types.ts). A JS Date here means an adapter is misconfigured: whether its local
 * or UTC fields hold the calendar date depends on the driver, so refuse to guess.
 */
export function dateOnly(value: unknown): string {
  if (typeof value === "string" && CALENDAR_DATE.test(value)) return value;
  if (value instanceof Date) {
    throw new TypeError(
      "date column arrived as a JS Date; configure the driver to return DATE as text (DATE_OID)",
    );
  }
  throw new TypeError(`expected a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`expected number, got ${String(value)}`);
  return n;
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`expected string, got ${typeof value}`);
  return value;
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

function obj(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

function strArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : (value ?? []);
  if (!Array.isArray(parsed)) throw new TypeError(`expected array, got ${typeof parsed}`);
  return parsed.map(str);
}

export const toOrganization = (r: Row): Organization => ({
  id: str(r.id),
  name: str(r.name),
  slug: strOrNull(r.slug),
  timezone: str(r.timezone),
  createdAt: iso(r.created_at),
});

export const toMembership = (r: Row): Membership => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  userId: str(r.user_id),
  role: str(r.role) as Membership["role"],
  email: strOrNull(r.email),
  createdAt: iso(r.created_at),
});

export const toCustomer = (r: Row): Customer => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  displayName: str(r.display_name),
  phone: strOrNull(r.phone),
  email: strOrNull(r.email),
  notes: strOrNull(r.notes),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toEmployee = (r: Row): Employee => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  displayName: str(r.display_name),
  phone: strOrNull(r.phone),
  email: strOrNull(r.email),
  active: Boolean(r.active),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toVendor = (r: Row): Vendor => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  displayName: str(r.display_name),
  phone: strOrNull(r.phone),
  email: strOrNull(r.email),
  approved: Boolean(r.approved),
  preferred: Boolean(r.preferred),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toJob = (r: Row): Job => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  customerId: strOrNull(r.customer_id),
  customerName: strOrNull(r.customer_name),
  name: str(r.name),
  status: str(r.status) as Job["status"],
  scheduledStart: isoOrNull(r.scheduled_start),
  scheduledEnd: isoOrNull(r.scheduled_end),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toTask = (r: Row): Task => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  title: str(r.title),
  description: strOrNull(r.description),
  status: str(r.status) as Task["status"],
  priority: str(r.priority) as Task["priority"],
  dueAt: isoOrNull(r.due_at),
  entityType: strOrNull(r.entity_type),
  entityId: strOrNull(r.entity_id),
  assignedUserId: strOrNull(r.assigned_user_id),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toApproval = (r: Row): Approval => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  type: str(r.type),
  title: str(r.title),
  description: strOrNull(r.description),
  status: str(r.status) as Approval["status"],
  riskClass: str(r.risk_class) as Approval["riskClass"],
  amountCents: numOrNull(r.amount_cents),
  currency: strOrNull(r.currency),
  entityType: strOrNull(r.entity_type),
  entityId: strOrNull(r.entity_id),
  requestedByActorType: str(r.requested_by_actor_type) as Approval["requestedByActorType"],
  requestedByActorId: strOrNull(r.requested_by_actor_id),
  decidedByUserId: strOrNull(r.decided_by_user_id),
  decidedAt: isoOrNull(r.decided_at),
  decisionNote: strOrNull(r.decision_note),
  idempotencyKey: str(r.idempotency_key),
  expiresAt: isoOrNull(r.expires_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toBusinessRule = (r: Row): BusinessRule => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  ruleKey: str(r.rule_key),
  action: str(r.action),
  version: Number(r.version),
  enabled: Boolean(r.enabled),
  definition: obj(r.definition),
  effectiveFrom: iso(r.effective_from),
  effectiveTo: isoOrNull(r.effective_to),
  createdByUserId: strOrNull(r.created_by_user_id),
  createdAt: iso(r.created_at),
});

export const toBusinessEvent = (r: Row): BusinessEvent => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  type: str(r.type),
  occurredAt: iso(r.occurred_at),
  source: str(r.source),
  sourceRef: strOrNull(r.source_ref),
  actorType: str(r.actor_type) as BusinessEvent["actorType"],
  actorId: strOrNull(r.actor_id),
  entityType: strOrNull(r.entity_type),
  entityId: strOrNull(r.entity_id),
  payload: obj(r.payload),
  correlationId: strOrNull(r.correlation_id),
  causationId: strOrNull(r.causation_id),
  idempotencyKey: strOrNull(r.idempotency_key),
});

export const toAuditLogEntry = (r: Row): AuditLogEntry => ({
  id: str(r.id),
  organizationId: strOrNull(r.organization_id),
  actorType: str(r.actor_type) as AuditLogEntry["actorType"],
  actorId: strOrNull(r.actor_id),
  action: str(r.action),
  entityType: strOrNull(r.entity_type),
  entityId: strOrNull(r.entity_id),
  approvalId: strOrNull(r.approval_id),
  sourceEventId: strOrNull(r.source_event_id),
  details: obj(r.details),
  createdAt: iso(r.created_at),
});

export const toOpsCase = (r: Row): OpsCase => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  title: str(r.title),
  reasonCode: str(r.reason_code),
  status: str(r.status) as OpsCase["status"],
  priority: str(r.priority) as OpsCase["priority"],
  entityType: strOrNull(r.entity_type),
  entityId: strOrNull(r.entity_id),
  evidence: obj(r.evidence),
  assignedOperatorUserId: strOrNull(r.assigned_operator_user_id),
  resolution: strOrNull(r.resolution),
  slaDueAt: isoOrNull(r.sla_due_at),
  automationGapCategory: strOrNull(r.automation_gap_category),
  ...(typeof r.organization_name === "string" ? { organizationName: r.organization_name } : {}),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toOperatorGrant = (r: Row): OperatorGrant => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  operatorUserId: str(r.operator_user_id),
  operatorEmail: strOrNull(r.operator_email),
  grantedByUserId: strOrNull(r.granted_by_user_id),
  reason: strOrNull(r.reason),
  expiresAt: iso(r.expires_at),
  revokedAt: isoOrNull(r.revoked_at),
  active: r.active === true,
  createdAt: iso(r.created_at),
});

export const toNote = (r: Row): Note => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  entityType: str(r.entity_type),
  entityId: str(r.entity_id),
  body: str(r.body),
  authorActorType: str(r.author_actor_type) as Note["authorActorType"],
  authorUserId: strOrNull(r.author_user_id),
  createdAt: iso(r.created_at),
});

export const toCommunication = (r: Row): Communication => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  channel: str(r.channel) as Communication["channel"],
  direction: str(r.direction) as Communication["direction"],
  status: str(r.status) as Communication["status"],
  provider: strOrNull(r.provider),
  providerConversationId: strOrNull(r.provider_conversation_id),
  startedAt: iso(r.started_at),
  endedAt: isoOrNull(r.ended_at),
  summary: strOrNull(r.summary),
  transcript: strOrNull(r.transcript),
  structuredExtraction: obj(r.structured_extraction),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toCall = (r: Row): Call => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  communicationId: str(r.communication_id),
  providerCallId: strOrNull(r.provider_call_id),
  fromNumber: strOrNull(r.from_number),
  toNumber: strOrNull(r.to_number),
  durationSeconds: numOrNull(r.duration_seconds),
  recordingUrl: strOrNull(r.recording_url),
  disposition: strOrNull(r.disposition),
  voicemail: Boolean(r.voicemail),
  createdAt: iso(r.created_at),
});

export const toMessage = (r: Row): Message => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  communicationId: str(r.communication_id),
  providerMessageId: strOrNull(r.provider_message_id),
  fromAddress: strOrNull(r.from_address),
  toAddress: strOrNull(r.to_address),
  body: strOrNull(r.body),
  mediaUrls: strArray(r.media_urls),
  createdAt: iso(r.created_at),
});

export const toCommunicationParticipant = (r: Row): CommunicationParticipant => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  communicationId: str(r.communication_id),
  role: str(r.role) as CommunicationParticipant["role"],
  customerId: strOrNull(r.customer_id),
  employeeId: strOrNull(r.employee_id),
  vendorId: strOrNull(r.vendor_id),
  phone: strOrNull(r.phone),
  email: strOrNull(r.email),
  displayName: strOrNull(r.display_name),
  createdAt: iso(r.created_at),
});

export const toLead = (r: Row): Lead => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  status: str(r.status) as Lead["status"],
  source: str(r.source) as Lead["source"],
  firstName: strOrNull(r.first_name),
  lastName: strOrNull(r.last_name),
  company: strOrNull(r.company),
  phone: strOrNull(r.phone),
  email: strOrNull(r.email),
  customerId: strOrNull(r.customer_id),
  assignedToEmployeeId: strOrNull(r.assigned_to_employee_id),
  originatingCommunicationId: strOrNull(r.originating_communication_id),
  description: strOrNull(r.description),
  lostReason: strOrNull(r.lost_reason),
  idempotencyKey: strOrNull(r.idempotency_key),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toTimeEntry = (r: Row): TimeEntry => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  employeeId: str(r.employee_id),
  jobId: str(r.job_id),
  workDate: dateOnly(r.work_date),
  startAt: isoOrNull(r.start_at),
  endAt: isoOrNull(r.end_at),
  hours: numOrNull(r.hours),
  status: str(r.status) as TimeEntry["status"],
  sourceCommunicationId: strOrNull(r.source_communication_id),
  factKey: strOrNull(r.fact_key),
  confidence: obj(r.confidence),
  evidence: obj(r.evidence),
  decidedByUserId: strOrNull(r.decided_by_user_id),
  decidedAt: isoOrNull(r.decided_at),
  decisionNote: strOrNull(r.decision_note),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toEquipmentUsage = (r: Row): EquipmentUsage => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  equipmentId: str(r.equipment_id),
  jobId: str(r.job_id),
  hours: numOrNull(r.hours),
  status: str(r.status) as EquipmentUsage["status"],
  sourceCommunicationId: strOrNull(r.source_communication_id),
  factKey: strOrNull(r.fact_key),
  confidence: obj(r.confidence),
  evidence: obj(r.evidence),
  decidedByUserId: strOrNull(r.decided_by_user_id),
  decidedAt: isoOrNull(r.decided_at),
  decisionNote: strOrNull(r.decision_note),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toMaterialUsage = (r: Row): MaterialUsage => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  jobId: str(r.job_id),
  description: str(r.description),
  quantity: numOrNull(r.quantity),
  unit: strOrNull(r.unit),
  status: str(r.status) as MaterialUsage["status"],
  sourceCommunicationId: strOrNull(r.source_communication_id),
  factKey: strOrNull(r.fact_key),
  confidence: obj(r.confidence),
  evidence: obj(r.evidence),
  decidedByUserId: strOrNull(r.decided_by_user_id),
  decidedAt: isoOrNull(r.decided_at),
  decisionNote: strOrNull(r.decision_note),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toBillableOpportunity = (r: Row): BillableOpportunity => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  jobId: str(r.job_id),
  description: str(r.description),
  quantity: numOrNull(r.quantity),
  unit: strOrNull(r.unit),
  status: str(r.status) as BillableOpportunity["status"],
  sourceCommunicationId: strOrNull(r.source_communication_id),
  confidence: obj(r.confidence),
  evidence: obj(r.evidence),
  decidedByUserId: strOrNull(r.decided_by_user_id),
  decidedAt: isoOrNull(r.decided_at),
  decisionNote: strOrNull(r.decision_note),
  decisionPolicySource: strOrNull(r.decision_policy_source),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toJobNote = (r: Row): JobNote => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  jobId: str(r.job_id),
  body: str(r.body),
  sourceCommunicationId: strOrNull(r.source_communication_id),
  factKey: strOrNull(r.fact_key),
  confidence: obj(r.confidence),
  evidence: obj(r.evidence),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toDocument = (r: Row): DocumentMetadata => ({
  id: str(r.id),
  organizationId: str(r.organization_id),
  storagePath: str(r.storage_path),
  fileName: str(r.file_name),
  mimeType: strOrNull(r.mime_type),
  classification: str(r.classification) as DocumentMetadata["classification"],
  entityType: strOrNull(r.entity_type),
  entityId: strOrNull(r.entity_id),
  sha256: strOrNull(r.sha256),
  createdAt: iso(r.created_at),
});
