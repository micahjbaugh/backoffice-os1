// Input validation for every domain tool. Server code validates all input with these schemas
// before touching the database, whether the caller is a human form, an agent, or a workflow.

import { z } from "zod";
import { ValidationError } from "./errors";
import { MEMBERSHIP_ROLES } from "./roles";
import {
  DOCUMENT_CLASSIFICATIONS,
  ENTITY_TYPES,
  JOB_STATUSES,
  OPS_CASE_REASON_CODES,
  OPS_CASE_STATUSES,
  PRIORITIES,
  TASK_STATUSES,
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
    ...entityRef,
  })
  .superRefine(refineEntityRef);

export const updateTaskStatusInput = z.object({
  status: z.enum(TASK_STATUSES),
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
export type CreateApprovalInput = z.input<typeof createApprovalInput>;
export type DecideApprovalInput = z.input<typeof decideApprovalInput>;
export type AddNoteInput = z.input<typeof addNoteInput>;
export type CreateOpsCaseInput = z.input<typeof createOpsCaseInput>;
export type UpdateOpsCaseInput = z.input<typeof updateOpsCaseInput>;
export type GrantOperatorAccessInput = z.input<typeof grantOperatorAccessInput>;
export type CreateApprovalRuleInput = z.input<typeof createApprovalRuleInput>;
export type RegisterDocumentInput = z.input<typeof registerDocumentInput>;
