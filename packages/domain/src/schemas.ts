// Input validation for every domain tool. Server code validates all input with these schemas
// before touching the database, whether the caller is a human form, an agent, or a workflow.

import { z } from "zod";
import { ValidationError } from "./errors";
import { normalizeToE164 } from "./phone";
import { MEMBERSHIP_ROLES } from "./roles";
import {
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_PARTICIPANT_ROLES,
  COMMUNICATION_STATUSES,
  DOCUMENT_CLASSIFICATIONS,
  ENTITY_TYPES,
  JOB_STATUSES,
  LEAD_SOURCES,
  OPS_CASE_REASON_CODES,
  OPS_CASE_STATUSES,
  PRIORITIES,
  PROVIDER_ROUTE_PROVIDERS,
  TASK_STATUSES,
  TRANSFER_REASONS,
} from "./types";

const uuid = z.uuid();
const name = z.string().trim().min(1).max(200);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));
const optionalEmail = z
  .union([z.literal(""), z.email().max(320)])
  .optional()
  .transform((v) => (v ? v.toLowerCase() : undefined));
const optionalPhone = z
  .string()
  .trim()
  .max(32)
  .regex(/^[+0-9 ()\-.]*$/, "phone may only contain digits and + ( ) - .")
  .optional()
  .transform((v) => (v ? v : undefined));
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const jsonObject = z.record(z.string(), z.unknown());

const entityRef = {
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: uuid.optional(),
};
function refineEntityRef(value: { entityType?: string; entityId?: string }, ctx: z.RefinementCtx) {
  if ((value.entityType === undefined) !== (value.entityId === undefined)) {
    ctx.addIssue({ code: "custom", message: "entityType and entityId must be provided together" });
  }
}

export const createOrganizationInput = z.object({
  name,
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, digits and dashes")
    .max(64)
    .optional(),
  timezone: z.string().trim().min(1).max(64).default("America/Chicago"),
});

export const addMemberInput = z.object({
  email: z
    .email()
    .max(320)
    .transform((v) => v.toLowerCase()),
  // Creating additional owners is a role change requiring two-step verification (SECURITY.md §8),
  // which is out of M1 scope, so it is not accepted here.
  role: z.enum(MEMBERSHIP_ROLES).exclude(["owner"]),
});

export const createCustomerInput = z.object({
  displayName: name,
  phone: optionalPhone,
  email: optionalEmail,
  notes: optionalText(4000),
});

export const createEmployeeInput = z.object({
  displayName: name,
  phone: optionalPhone,
  email: optionalEmail,
});

export const createVendorInput = z.object({
  displayName: name,
  phone: optionalPhone,
  email: optionalEmail,
  preferred: z.boolean().default(false),
});

export const createJobInput = z.object({
  name,
  customerId: uuid.optional(),
  status: z.enum(JOB_STATUSES).default("draft"),
  scheduledStart: isoDateTime.optional(),
  scheduledEnd: isoDateTime.optional(),
});

export const updateJobInput = z
  .object({
    name: name.optional(),
    status: z.enum(JOB_STATUSES).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, "nothing to update");

export const createTaskInput = z
  .object({
    title: name,
    description: optionalText(4000),
    priority: z.enum(PRIORITIES).default("normal"),
    dueAt: isoDateTime.optional(),
    assignedUserId: uuid.optional(),
    /** Set by agent-callable wrappers (e.g. createCallbackTask); manual/UI tasks omit it. */
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
    ...entityRef,
  })
  .superRefine(refineEntityRef);

export const updateTaskStatusInput = z.object({
  status: z.enum(TASK_STATUSES),
});

/**
 * Agent-callable: a task linked to the call/communication that prompted it. Idempotent on
 * (organization_id, idempotency_key) so a retried/duplicate tool call never creates a second task.
 */
export const createCallbackTaskInput = z.object({
  communicationId: uuid,
  title: name,
  description: optionalText(4000),
  priority: z.enum(PRIORITIES).default("normal"),
  dueAt: isoDateTime.optional(),
  assignedUserId: uuid.optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export const createApprovalInput = z
  .object({
    type: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, "type must be dotted snake_case")
      .max(64),
    title: name,
    description: optionalText(4000),
    riskClass: z.enum(["green", "yellow", "red"]).default("yellow"),
    amountCents: z.number().int().nonnegative().max(1_000_000_000_00).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    expiresAt: isoDateTime.optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
    ...entityRef,
  })
  .superRefine(refineEntityRef);

export const decideApprovalInput = z.object({
  approvalId: uuid,
  decision: z.enum(["approved", "rejected"]),
  note: optionalText(2000),
});

export const addNoteInput = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: uuid,
  body: z.string().trim().min(1).max(4000),
});

export const createOpsCaseInput = z
  .object({
    title: name,
    reasonCode: z.enum(OPS_CASE_REASON_CODES),
    priority: z.enum(PRIORITIES).default("normal"),
    evidence: jsonObject.default({}),
    slaDueAt: isoDateTime.optional(),
    ...entityRef,
  })
  .superRefine(refineEntityRef);

export const updateOpsCaseInput = z
  .object({
    status: z.enum(OPS_CASE_STATUSES).optional(),
    resolution: optionalText(4000),
    automationGapCategory: optionalText(64),
    assignToSelf: z.boolean().optional(),
  })
  .refine(
    (v) => v.status !== "resolved" || (v.resolution !== undefined && v.resolution.length > 0),
    "resolution is required when resolving a case",
  );

/** twilio only ships an SmsProvider adapter and vapi only a VoiceProvider one (packages/integrations). */
const PROVIDER_ROUTE_CHANNEL_BY_PROVIDER: Record<
  (typeof PROVIDER_ROUTE_PROVIDERS)[number],
  string
> = {
  twilio: "sms",
  vapi: "voice",
};

export const registerProviderRouteInput = z
  .object({
    provider: z.enum(PROVIDER_ROUTE_PROVIDERS),
    channel: z.enum(["sms", "voice"]),
    address: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .transform((v, ctx) => {
        const parsed = normalizeToE164(v);
        if (!parsed) {
          ctx.addIssue({ code: "custom", message: "address must be a valid phone number" });
          return z.NEVER;
        }
        return parsed.e164;
      }),
  })
  .refine((v) => PROVIDER_ROUTE_CHANNEL_BY_PROVIDER[v.provider] === v.channel, {
    message: "channel does not match the provider's adapter",
    path: ["channel"],
  });
export type RegisterProviderRouteInput = z.input<typeof registerProviderRouteInput>;

const MAX_GRANT_HOURS = 24 * 7;
export const grantOperatorAccessInput = z.object({
  operatorEmail: z
    .email()
    .max(320)
    .transform((v) => v.toLowerCase()),
  reason: z.string().trim().min(5).max(500),
  durationHours: z.number().int().min(1).max(MAX_GRANT_HOURS).default(24),
});

export const createApprovalRuleInput = z.object({
  ruleKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.-]+$/)
    .max(64),
  approvalTypes: z.array(z.string().trim().min(1).max(64)).min(1).max(50).optional(),
  roles: z.array(z.enum(["owner", "office_admin"])).min(1),
  maxAmountCents: z.number().int().nonnegative().optional(),
});

export const registerDocumentInput = z
  .object({
    storagePath: z.string().trim().min(1).max(1024),
    fileName: z.string().trim().min(1).max(255),
    mimeType: optionalText(255),
    classification: z.enum(DOCUMENT_CLASSIFICATIONS).default("confidential"),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    ...entityRef,
  })
  .superRefine(refineEntityRef);

const communicationParticipantInput = z.object({
  role: z.enum(COMMUNICATION_PARTICIPANT_ROLES).default("unknown"),
  customerId: uuid.optional(),
  employeeId: uuid.optional(),
  vendorId: uuid.optional(),
  phone: optionalPhone,
  email: optionalEmail,
  displayName: optionalText(200),
});

const communicationEnvelope = {
  direction: z.enum(COMMUNICATION_DIRECTIONS),
  provider: z.string().trim().min(1).max(64),
  providerConversationId: z.string().trim().min(1).max(200),
  status: z.enum(COMMUNICATION_STATUSES).default("in_progress"),
  startedAt: isoDateTime.optional(),
  endedAt: isoDateTime.optional(),
  summary: optionalText(4000),
  transcript: optionalText(50000),
  participants: z.array(communicationParticipantInput).max(20).default([]),
};

export const recordCallInput = z.object({
  ...communicationEnvelope,
  providerCallId: optionalText(200),
  fromNumber: optionalPhone,
  toNumber: optionalPhone,
  durationSeconds: z.number().int().nonnegative().optional(),
  recordingUrl: optionalText(2048),
  disposition: optionalText(64),
  voicemail: z.boolean().default(false),
});

export const recordMessageInput = z.object({
  ...communicationEnvelope,
  channel: z.enum(["sms", "email"]).default("sms"),
  providerMessageId: optionalText(200),
  fromAddress: optionalText(320),
  toAddress: optionalText(320),
  body: optionalText(4000),
  mediaUrls: z.array(z.string().trim().max(2048)).max(20).default([]),
});

export const createLeadInput = z.object({
  source: z.enum(LEAD_SOURCES).default("other"),
  firstName: optionalText(120),
  lastName: optionalText(120),
  company: optionalText(200),
  phone: optionalPhone,
  email: optionalEmail,
  description: optionalText(4000),
  customerId: uuid.optional(),
  assignedToEmployeeId: uuid.optional(),
  originatingCommunicationId: uuid.optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

/** Shared by every draft-fact create input: pairs sourceCommunicationId with factKey for idempotency. */
const draftFactFields = {
  sourceCommunicationId: uuid.optional(),
  factKey: z.string().trim().min(1).max(200).optional(),
  confidence: jsonObject.default({}),
  evidence: jsonObject.default({}),
};
function refineFactRef(
  value: { sourceCommunicationId?: string; factKey?: string },
  ctx: z.RefinementCtx,
) {
  if ((value.sourceCommunicationId === undefined) !== (value.factKey === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "sourceCommunicationId and factKey must be provided together",
    });
  }
}

/** Agent-callable: a draft time entry extracted from a crew report (MASTER_SPEC §C, GREEN action). */
export const DECIDABLE_DRAFT_KINDS = ["time_entry", "equipment_usage", "material_usage"] as const;
export type DecidableDraftKind = (typeof DECIDABLE_DRAFT_KINDS)[number];

export const decideDraftRecordInput = z.object({
  kind: z.enum(DECIDABLE_DRAFT_KINDS),
  id: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(2000).optional(),
});
export type DecideDraftRecordInput = z.input<typeof decideDraftRecordInput>;

export const decideBillableOpportunityInput = z.object({
  id: z.uuid(),
  decision: z.enum(["approved", "dismissed"]),
  note: z.string().trim().max(2000).optional(),
});
export type DecideBillableOpportunityInput = z.input<typeof decideBillableOpportunityInput>;

export const createDraftTimeEntryInput = z
  .object({
    employeeId: uuid,
    jobId: uuid,
    workDate: isoDate,
    startAt: isoDateTime.optional(),
    endAt: isoDateTime.optional(),
    hours: z.number().nonnegative().max(100).optional(),
    ...draftFactFields,
  })
  .superRefine(refineFactRef);

export const createDraftEquipmentUsageInput = z
  .object({
    equipmentId: uuid,
    jobId: uuid,
    hours: z.number().nonnegative().max(100).optional(),
    ...draftFactFields,
  })
  .superRefine(refineFactRef);

export const createDraftMaterialUsageInput = z
  .object({
    jobId: uuid,
    description: z.string().trim().min(1).max(500),
    quantity: z.number().nonnegative().max(1_000_000).optional(),
    unit: optionalText(32),
    ...draftFactFields,
  })
  .superRefine(refineFactRef);

export const createDraftJobNoteInput = z
  .object({
    jobId: uuid,
    body: z.string().trim().min(1).max(4000),
    ...draftFactFields,
  })
  .superRefine(refineFactRef);

export const updateCommunicationSummaryInput = z.object({
  communicationId: uuid,
  status: z.enum(COMMUNICATION_STATUSES).optional(),
  endedAt: isoDateTime.optional(),
  summary: optionalText(4000),
  transcript: optionalText(50000),
  structuredExtraction: jsonObject.optional(),
});

/** Warm-transfer a voice call to an in-org employee, routed through VoiceProvider.transferCall. */
export const transferCallInput = z.object({
  communicationId: uuid,
  toEmployeeId: uuid,
  reason: z.enum(TRANSFER_REASONS),
  note: optionalText(500),
  idempotencyKey: z.string().trim().min(8).max(200),
});

/**
 * Record the outcome of an ended voice call. Idempotent on (organization_id, providerEventId): a
 * replayed call-ended webhook must reuse `providerEventId` so the disposition is written once.
 */
export const recordCallDispositionInput = z.object({
  communicationId: uuid,
  disposition: z.string().trim().min(1).max(64),
  providerEventId: z.string().trim().min(1).max(200),
  endedAt: isoDateTime.optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  recordingUrl: optionalText(2048),
});

/** Parse `input` with `schema`, converting failures into a domain ValidationError. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    );
  }
  return result.data;
}

export type CreateOrganizationInput = z.input<typeof createOrganizationInput>;
export type AddMemberInput = z.input<typeof addMemberInput>;
export type CreateCustomerInput = z.input<typeof createCustomerInput>;
export type CreateEmployeeInput = z.input<typeof createEmployeeInput>;
export type CreateVendorInput = z.input<typeof createVendorInput>;
export type CreateJobInput = z.input<typeof createJobInput>;
export type UpdateJobInput = z.input<typeof updateJobInput>;
export type CreateTaskInput = z.input<typeof createTaskInput>;
export type CreateCallbackTaskInput = z.input<typeof createCallbackTaskInput>;
export type CreateApprovalInput = z.input<typeof createApprovalInput>;
export type DecideApprovalInput = z.input<typeof decideApprovalInput>;
export type AddNoteInput = z.input<typeof addNoteInput>;
export type CreateOpsCaseInput = z.input<typeof createOpsCaseInput>;
export type UpdateOpsCaseInput = z.input<typeof updateOpsCaseInput>;
export type GrantOperatorAccessInput = z.input<typeof grantOperatorAccessInput>;
export type CreateApprovalRuleInput = z.input<typeof createApprovalRuleInput>;
export type RegisterDocumentInput = z.input<typeof registerDocumentInput>;
export type RecordCallInput = z.input<typeof recordCallInput>;
export type RecordMessageInput = z.input<typeof recordMessageInput>;
export type UpdateCommunicationSummaryInput = z.input<typeof updateCommunicationSummaryInput>;
export type CreateLeadInput = z.input<typeof createLeadInput>;
export type CreateDraftTimeEntryInput = z.input<typeof createDraftTimeEntryInput>;
export type CreateDraftEquipmentUsageInput = z.input<typeof createDraftEquipmentUsageInput>;
export type CreateDraftMaterialUsageInput = z.input<typeof createDraftMaterialUsageInput>;
export type CreateDraftJobNoteInput = z.input<typeof createDraftJobNoteInput>;
export type TransferCallInput = z.input<typeof transferCallInput>;
export type RecordCallDispositionInput = z.input<typeof recordCallDispositionInput>;
