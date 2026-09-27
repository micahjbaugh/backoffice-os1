// Code-level permission matrix. This (not prompt text) decides what an actor may do.
// Database RLS mirrors these as a tenant-isolation and role ceiling; see 0002_m1_foundation.sql.

import type { MembershipRole } from "./roles";
import type { Actor } from "./types";

export const PERMISSIONS = [
  "org.read",
  "member.read",
  "member.manage",
  "customer.read",
  "customer.write",
  "employee.read",
  "employee.write",
  "vendor.read",
  "vendor.write",
  "job.read",
  "job.write",
  "equipment.read",
  "task.read",
  "task.create",
  "task.update",
  "approval.read",
  "approval.request",
  /** Eligibility to decide at all; per-approval authority is `evaluateApprovalDecision`. */
  "approval.decide",
  "note.read",
  "note.add",
  "rule.read",
  "rule.write",
  "event.read",
  "audit.read",
  "ops_case.read",
  "ops_case.create",
  "operator_grant.manage",
  "provider_route.manage",
  "document.read",
  "document.write",
  "communication.read",
  "communication.write",
  "lead.read",
  "lead.write",
  /** Read-only, caller-safe business info lookup (hours/services/service area/address) only. */
  "receptionist.lookup",
  "time_entry.write",
  "equipment_usage.write",
  "material_usage.write",
  "job_note.write",
  "billable_opportunity.write",
  /** Approve/reject draft time, equipment and material records. */
  "draft_record.decide",
  /** Eligibility to decide billable opportunities; final authority is the approval policy. */
  "billable.decide",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STAFF_WRITE: readonly Permission[] = [
  "customer.write",
  "employee.write",
  "vendor.write",
  "job.write",
  "task.create",
  "task.update",
  "approval.request",
  "note.add",
  "ops_case.create",
  "document.write",
  "lead.write",
  "time_entry.write",
  "equipment_usage.write",
  "material_usage.write",
  "job_note.write",
  "billable_opportunity.write",
];

const STAFF_READ: readonly Permission[] = [
  "org.read",
  "member.read",
  "customer.read",
  "employee.read",
  "vendor.read",
  "job.read",
  "equipment.read",
  "task.read",
  "approval.read",
  "note.read",
  "rule.read",
  "event.read",
  "ops_case.read",
  "document.read",
  "communication.read",
  "lead.read",
];

export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, ReadonlySet<Permission>>> = {
  owner: new Set<Permission>(PERMISSIONS),
  office_admin: new Set<Permission>([
    ...STAFF_READ,
    ...STAFF_WRITE,
    "approval.decide",
    "audit.read",
    "draft_record.decide",
    "billable.decide",
  ]),
  manager: new Set<Permission>([...STAFF_READ, ...STAFF_WRITE, "draft_record.decide"]),
  field_employee: new Set<Permission>([
    "org.read",
    "customer.read",
    "employee.read",
    "vendor.read",
    "job.read",
    "equipment.read",
    "task.read",
    "approval.request",
    "document.read",
  ]),
  accountant_readonly: new Set<Permission>([...STAFF_READ, "audit.read"]),
};

/**
 * Non-human actors are limited to GREEN actions (MASTER_SPEC §8): they may create drafts,
 * tasks, approval *requests* and ops cases, but can never decide approvals or change rules.
 */
const AUTOMATED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "task.create",
  "approval.request",
  "note.add",
  "ops_case.create",
  "communication.write",
  "lead.write",
  "receptionist.lookup",
  "time_entry.write",
  "equipment_usage.write",
  "material_usage.write",
  "job_note.write",
  "billable_opportunity.write",
]);

/** Trusted server components (e.g. seeding, background workflows) get the green set plus reads. */
const SYSTEM_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  ...AUTOMATED_PERMISSIONS,
  ...STAFF_READ,
]);

export function roleHasPermission(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Whether an actor may perform `permission` in a tenant.
 * `role` is the actor's membership role in that tenant (null when not a member).
 * Internal operators get no tenant permissions from this matrix; their access is via scoped grants.
 */
export function actorHasPermission(
  actor: Actor,
  role: MembershipRole | null,
  permission: Permission,
): boolean {
  switch (actor.type) {
    case "user":
      return role !== null && roleHasPermission(role, permission);
    case "agent":
    case "integration":
      return AUTOMATED_PERMISSIONS.has(permission);
    case "system":
      return SYSTEM_PERMISSIONS.has(permission);
    case "internal_operator":
      return false;
  }
}
