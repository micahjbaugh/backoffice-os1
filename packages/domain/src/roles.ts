export const MEMBERSHIP_ROLES = [
  "owner",
  "office_admin",
  "manager",
  "field_employee",
  "accountant_readonly",
] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** Internal (Back Office OS staff) roles. These are not tenant roles and grant no tenant access alone. */
export const INTERNAL_STAFF_ROLES = ["ops_agent", "ops_supervisor", "platform_admin"] as const;
export type InternalStaffRole = (typeof INTERNAL_STAFF_ROLES)[number];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

export function isInternalStaffRole(value: unknown): value is InternalStaffRole {
  return typeof value === "string" && (INTERNAL_STAFF_ROLES as readonly string[]).includes(value);
}
