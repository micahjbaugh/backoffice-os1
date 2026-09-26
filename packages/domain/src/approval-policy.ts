// Deterministic approval-decision authority. Rules are data (business_rules), evaluated in code.

import { z } from "zod";
import type { MembershipRole } from "./roles";
import type { Actor, RiskClass } from "./types";

/** Approval types that move money or commit the business financially. */
export const FINANCIAL_APPROVAL_TYPES = [
  "purchase",
  "invoice",
  "payment",
  "refund",
  "credit",
  "change_order",
  "overtime",
  "expense",
  "vendor_bill",
  "payroll",
] as const;

export const APPROVAL_DECIDE_RULE_ACTION = "approval.decide";

/** Roles that a business rule may delegate decision authority to. Owner always has it. */
export const DELEGABLE_DECISION_ROLES = ["owner", "office_admin"] as const;
export type DelegableDecisionRole = (typeof DELEGABLE_DECISION_ROLES)[number];

export const approvalDelegationDefinitionSchema = z
  .object({
    approval_types: z.array(z.string().trim().min(1).max(64)).min(1).max(50).optional(),
    roles: z.array(z.enum(DELEGABLE_DECISION_ROLES)).min(1),
    max_amount_cents: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ApprovalDelegationDefinition = z.infer<typeof approvalDelegationDefinitionSchema>;

export interface ApprovalDelegationRule {
  id: string;
  version: number;
  definition: ApprovalDelegationDefinition;
}

export interface ApprovalPolicySubject {
  type: string;
  riskClass: RiskClass;
  amountCents: number | null;
}

export type DecisionAuthority =
  | { allowed: true; policySource: string }
  | { allowed: false; reason: string; policySource: string };

export function isFinancialApproval(approval: Pick<ApprovalPolicySubject, "type" | "amountCents">) {
  const category = approval.type.split(".")[0] ?? approval.type;
  return (
    approval.amountCents !== null ||
    (FINANCIAL_APPROVAL_TYPES as readonly string[]).includes(category)
  );
}

function ruleCovers(
  rule: ApprovalDelegationRule,
  role: DelegableDecisionRole,
  approval: ApprovalPolicySubject,
) {
  const { approval_types, roles, max_amount_cents } = rule.definition;
  if (!roles.includes(role)) return false;
  if (approval_types && !approval_types.includes(approval.type)) return false;
  if (max_amount_cents !== undefined) {
    if (approval.amountCents === null || approval.amountCents > max_amount_cents) return false;
  }
  return true;
}

/**
 * Decide whether `actor` (with tenant `role`) may approve or reject `approval`.
 *
 * Ceiling rules that business rules can never override:
 * - only human tenant members decide; agents/integrations/system/internal operators never do
 * - manager, field_employee and accountant_readonly never decide
 * - RED risk approvals are owner-only
 * Defaults: owner decides anything; office_admin decides non-financial approvals, and financial
 * approvals only where an active `approval.decide` business rule delegates it.
 */
export function evaluateApprovalDecision(
  actor: Actor,
  role: MembershipRole | null,
  approval: ApprovalPolicySubject,
  rules: readonly ApprovalDelegationRule[],
): DecisionAuthority {
  if (actor.type !== "user") {
    return {
      allowed: false,
      reason: "only_human_members_decide",
      policySource: "ceiling:human_decision",
    };
  }
  if (role === null) {
    return { allowed: false, reason: "not_a_member", policySource: "ceiling:membership" };
  }
  if (role === "owner") {
    return { allowed: true, policySource: "default:owner" };
  }
  if (role !== "office_admin") {
    return { allowed: false, reason: "role_cannot_decide", policySource: "ceiling:role" };
  }
  if (approval.riskClass === "red") {
    return { allowed: false, reason: "red_requires_owner", policySource: "ceiling:red_risk" };
  }
  if (!isFinancialApproval(approval)) {
    return { allowed: true, policySource: "default:office_admin_non_financial" };
  }
  const delegating = rules.find((rule) => ruleCovers(rule, role, approval));
  if (delegating) {
    return { allowed: true, policySource: `business_rule:${delegating.id}@v${delegating.version}` };
  }
  return {
    allowed: false,
    reason: "financial_requires_owner",
    policySource: "default:financial_owner_only",
  };
}
