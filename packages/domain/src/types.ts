// Shared domain types. Provider-independent: nothing here knows about Supabase, pg, or any vendor.

import type { MembershipRole, InternalStaffRole } from "./roles";

export type UUID = string;

export type ActorType = "user" | "agent" | "internal_operator" | "integration" | "system";

export type RiskClass = "green" | "yellow" | "red";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export type ApprovalDecision = "approved" | "rejected";

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const JOB_STATUSES = [
  "draft",
  "scheduled",
  "active",
  "paused",
  "completed",
  "invoiced",
  "closed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const OPS_CASE_STATUSES = [
  "new",
  "assigned",
  "waiting_external",
  "resolved",
  "closed",
] as const;
export type OpsCaseStatus = (typeof OPS_CASE_STATUSES)[number];

/** Why a workflow escalated to the human backstop (MASTER_SPEC §9). */
export const OPS_CASE_REASON_CODES = [
  "low_confidence",
  "policy_conflict",
  "missing_data",
  "integration_failure",
  "caller_requested_human",
  "unusual_financial_decision",
  "external_dispute",
  "other",
] as const;
export type OpsCaseReasonCode = (typeof OPS_CASE_REASON_CODES)[number];

export const DOCUMENT_CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
  "financial",
  "employee_sensitive",
  "credential_secret",
] as const;
export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

/** Entity types that polymorphic references (entity_type/entity_id) may point at. */
export const ENTITY_TYPES = [
  "customer",
  "employee",
  "vendor",
  "job",
  "task",
  "approval",
  "ops_case",
  "document",
  "communication",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Who is performing an action. Users and internal operators are authenticated humans;
 * agents, integrations and system components are trusted server-side code paths.
 */
export type Actor =
  | { type: "user"; userId: UUID }
  | { type: "internal_operator"; userId: UUID }
  | { type: "agent"; name: string }
  | { type: "integration"; name: string }
  | { type: "system"; name: string };

export function actorUserId(actor: Actor): UUID | null {
  return actor.type === "user" || actor.type === "internal_operator" ? actor.userId : null;
}

export function actorLabel(actor: Actor): string {
  return actor.type === "user" || actor.type === "internal_operator"
    ? `${actor.type}:${actor.userId}`
    : `${actor.type}:${actor.name}`;
}

export interface TenantEntity {
  id: UUID;
  organizationId: UUID;
  createdAt: string;
}

export interface Organization {
  id: UUID;
  name: string;
  slug: string | null;
  timezone: string;
  createdAt: string;
}

export interface Membership {
  id: UUID;
  organizationId: UUID;
  userId: UUID;
  role: MembershipRole;
  email: string | null;
  createdAt: string;
}

export interface Customer extends TenantEntity {
  displayName: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface Employee extends TenantEntity {
  displayName: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  updatedAt: string;
}

export interface Vendor extends TenantEntity {
  displayName: string;
  phone: string | null;
  email: string | null;
  approved: boolean;
  preferred: boolean;
  updatedAt: string;
}

export interface Job extends TenantEntity {
  customerId: UUID | null;
  customerName: string | null;
  name: string;
  status: JobStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  updatedAt: string;
}

export interface Task extends TenantEntity {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  entityType: string | null;
  entityId: UUID | null;
  assignedUserId: UUID | null;
  updatedAt: string;
}

export interface Approval extends TenantEntity {
  type: string;
  title: string;
  description: string | null;
  status: ApprovalStatus;
  riskClass: RiskClass;
  amountCents: number | null;
  currency: string | null;
  entityType: string | null;
  entityId: UUID | null;
  requestedByActorType: ActorType;
  requestedByActorId: UUID | null;
  decidedByUserId: UUID | null;
  decidedAt: string | null;
  decisionNote: string | null;
  idempotencyKey: string;
  expiresAt: string | null;
  updatedAt: string;
}

export interface BusinessRule extends TenantEntity {
  ruleKey: string;
  action: string;
  version: number;
  enabled: boolean;
  definition: Record<string, unknown>;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdByUserId: UUID | null;
}

export interface BusinessEvent {
  id: UUID;
  organizationId: UUID;
  type: string;
  occurredAt: string;
  source: string;
  sourceRef: string | null;
  actorType: ActorType;
  actorId: UUID | null;
  entityType: string | null;
  entityId: UUID | null;
  payload: Record<string, unknown>;
  correlationId: UUID | null;
  causationId: UUID | null;
  idempotencyKey: string | null;
}

export interface AuditLogEntry {
  id: UUID;
  organizationId: UUID | null;
  actorType: ActorType;
  actorId: UUID | null;
  action: string;
  entityType: string | null;
  entityId: UUID | null;
  approvalId: UUID | null;
  sourceEventId: UUID | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OpsCase extends TenantEntity {
  title: string;
  reasonCode: string;
  status: OpsCaseStatus;
  priority: Priority;
  entityType: string | null;
  entityId: UUID | null;
  evidence: Record<string, unknown>;
  assignedOperatorUserId: UUID | null;
  resolution: string | null;
  slaDueAt: string | null;
  automationGapCategory: string | null;
  organizationName?: string;
  updatedAt: string;
}

export interface OperatorGrant extends TenantEntity {
  operatorUserId: UUID;
  operatorEmail: string | null;
  grantedByUserId: UUID | null;
  reason: string | null;
  expiresAt: string;
  revokedAt: string | null;
  /** Not revoked and not expired, per the database clock. */
  active: boolean;
}

export interface Note extends TenantEntity {
  entityType: string;
  entityId: UUID;
  body: string;
  authorActorType: ActorType;
  authorUserId: UUID | null;
}

export interface DocumentMetadata extends TenantEntity {
  storagePath: string;
  fileName: string;
  mimeType: string | null;
  classification: DocumentClassification;
  entityType: string | null;
  entityId: UUID | null;
  sha256: string | null;
}

export interface InternalStaff {
  userId: UUID;
  role: InternalStaffRole;
  active: boolean;
}

export const COMMUNICATION_CHANNELS = ["voice", "sms", "email"] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const COMMUNICATION_DIRECTIONS = ["inbound", "outbound"] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

export const COMMUNICATION_STATUSES = ["in_progress", "completed", "failed", "abandoned"] as const;
export type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];

export const TRANSFER_REASONS = [
  "caller_requested_human",
  "uncertain_intake",
  "outside_permitted_topics",
  "provider_failure",
] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];

export const COMMUNICATION_PARTICIPANT_ROLES = [
  "customer",
  "employee",
  "vendor",
  "agent",
  "unknown",
] as const;
export type CommunicationParticipantRole = (typeof COMMUNICATION_PARTICIPANT_ROLES)[number];

export interface Communication extends TenantEntity {
  channel: CommunicationChannel;
  direction: CommunicationDirection;
  status: CommunicationStatus;
  provider: string | null;
  providerConversationId: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  transcript: string | null;
  structuredExtraction: Record<string, unknown>;
  updatedAt: string;
}

export interface Call {
  id: UUID;
  organizationId: UUID;
  communicationId: UUID;
  providerCallId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
  disposition: string | null;
  voicemail: boolean;
  createdAt: string;
}

export interface Message {
  id: UUID;
  organizationId: UUID;
  communicationId: UUID;
  providerMessageId: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  body: string | null;
  mediaUrls: string[];
  createdAt: string;
}

export interface CommunicationParticipant {
  id: UUID;
  organizationId: UUID;
  communicationId: UUID;
  role: CommunicationParticipantRole;
  customerId: UUID | null;
  employeeId: UUID | null;
  vendorId: UUID | null;
  phone: string | null;
  email: string | null;
  displayName: string | null;
  createdAt: string;
}

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "unqualified",
  "converted",
  "lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = ["voice", "sms", "email", "web_form", "referral", "manual", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export interface Lead extends TenantEntity {
  status: LeadStatus;
  source: LeadSource;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  customerId: UUID | null;
  assignedToEmployeeId: UUID | null;
  originatingCommunicationId: UUID | null;
  description: string | null;
  lostReason: string | null;
  idempotencyKey: string | null;
  updatedAt: string;
}

export const DRAFT_RECORD_STATUSES = ["draft", "approved", "rejected"] as const;
export type DraftRecordStatus = (typeof DRAFT_RECORD_STATUSES)[number];

/** Fields shared by every fact drafted from a crew communication (MASTER_SPEC §C). */
export interface DraftFact {
  sourceCommunicationId: UUID | null;
  /** Identifies this fact within its communication; pairs with sourceCommunicationId for idempotency. */
  factKey: string | null;
  confidence: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

export interface TimeEntry extends TenantEntity, DraftFact {
  employeeId: UUID;
  jobId: UUID;
  workDate: string;
  startAt: string | null;
  endAt: string | null;
  hours: number | null;
  status: DraftRecordStatus;
  updatedAt: string;
}

export interface EquipmentUsage extends TenantEntity, DraftFact {
  equipmentId: UUID;
  jobId: UUID;
  hours: number | null;
  status: DraftRecordStatus;
  updatedAt: string;
}

export interface MaterialUsage extends TenantEntity, DraftFact {
  jobId: UUID;
  description: string;
  quantity: number | null;
  unit: string | null;
  status: DraftRecordStatus;
  updatedAt: string;
}

export interface JobNote extends TenantEntity, DraftFact {
  jobId: UUID;
  body: string;
  updatedAt: string;
}
