import { describe, expect, it } from "vitest";
import {
  actorHasPermission,
  approvalDelegationDefinitionSchema,
  evaluateApprovalDecision,
  isFinancialApproval,
  MEMBERSHIP_ROLES,
  type Actor,
  type ApprovalDelegationRule,
  type ApprovalPolicySubject,
  type MembershipRole,
} from "../src";

const user: Actor = { type: "user", userId: "00000000-0000-4000-8000-000000000001" };
const purchase: ApprovalPolicySubject = {
  type: "purchase",
  riskClass: "yellow",
  amountCents: 45_000,
};
const schedule: ApprovalPolicySubject = {
  type: "schedule.change",
  riskClass: "yellow",
  amountCents: null,
};
const redCapital: ApprovalPolicySubject = {
  type: "purchase",
  riskClass: "red",
  amountCents: 9_000_000,
};

const delegatePurchasesUpTo500: ApprovalDelegationRule = {
  id: "rule-1",
  version: 2,
  definition: { approval_types: ["purchase"], roles: ["office_admin"], max_amount_cents: 50_000 },
};

describe("evaluateApprovalDecision", () => {
  it("lets the owner decide anything, including red approvals", () => {
    for (const approval of [purchase, schedule, redCapital]) {
      expect(evaluateApprovalDecision(user, "owner", approval, [])).toEqual({
        allowed: true,
        policySource: "default:owner",
      });
    }
  });

  it.each<MembershipRole>(["field_employee", "manager", "accountant_readonly"])(
    "never lets %s decide, even with a delegating rule",
    (role) => {
      const everything: ApprovalDelegationRule = {
        id: "r",
        version: 1,
        definition: { roles: ["owner", "office_admin"] },
      };
      for (const approval of [purchase, schedule]) {
        const result = evaluateApprovalDecision(user, role, approval, [everything]);
        expect(result.allowed).toBe(false);
      }
    },
  );

  it("lets office_admin decide non-financial approvals by default", () => {
    expect(evaluateApprovalDecision(user, "office_admin", schedule, []).allowed).toBe(true);
  });

  it("requires the owner for financial approvals unless a rule delegates", () => {
    const denied = evaluateApprovalDecision(user, "office_admin", purchase, []);
    expect(denied).toMatchObject({ allowed: false, reason: "financial_requires_owner" });

    const allowed = evaluateApprovalDecision(user, "office_admin", purchase, [
      delegatePurchasesUpTo500,
    ]);
    expect(allowed).toEqual({ allowed: true, policySource: "business_rule:rule-1@v2" });
  });

  it("respects the delegated amount limit and approval types", () => {
    const over = { ...purchase, amountCents: 50_001 };
    expect(
      evaluateApprovalDecision(user, "office_admin", over, [delegatePurchasesUpTo500]).allowed,
    ).toBe(false);
    const invoice = { ...purchase, type: "invoice" };
    expect(
      evaluateApprovalDecision(user, "office_admin", invoice, [delegatePurchasesUpTo500]).allowed,
    ).toBe(false);
  });

  it("never delegates red approvals", () => {
    const all: ApprovalDelegationRule = {
      id: "r",
      version: 1,
      definition: { roles: ["office_admin"] },
    };
    expect(evaluateApprovalDecision(user, "office_admin", redCapital, [all])).toMatchObject({
      allowed: false,
      reason: "red_requires_owner",
    });
  });

  it.each<Actor>([
    { type: "agent", name: "owner_assistant" },
    { type: "system", name: "workflow" },
    { type: "integration", name: "qbo" },
    { type: "internal_operator", userId: "00000000-0000-4000-8000-000000000002" },
  ])("never lets a $type actor decide", (actor) => {
    expect(evaluateApprovalDecision(actor, "owner", schedule, []).allowed).toBe(false);
  });

  it("denies non-members", () => {
    expect(evaluateApprovalDecision(user, null, schedule, [])).toMatchObject({
      allowed: false,
      reason: "not_a_member",
    });
  });
});

describe("delegation rule schema", () => {
  it("rejects delegation to roles above the ceiling", () => {
    expect(approvalDelegationDefinitionSchema.safeParse({ roles: ["manager"] }).success).toBe(
      false,
    );
    expect(
      approvalDelegationDefinitionSchema.safeParse({ roles: ["field_employee"] }).success,
    ).toBe(false);
    expect(approvalDelegationDefinitionSchema.safeParse({ roles: ["office_admin"] }).success).toBe(
      true,
    );
  });
});

describe("isFinancialApproval", () => {
  it("treats amounts and financial categories as financial", () => {
    expect(isFinancialApproval({ type: "schedule.change", amountCents: 100 })).toBe(true);
    expect(isFinancialApproval({ type: "invoice.send", amountCents: null })).toBe(true);
    expect(isFinancialApproval({ type: "schedule.change", amountCents: null })).toBe(false);
  });
});

describe("actorHasPermission", () => {
  it("gives only owners rule and grant management", () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(actorHasPermission(user, role, "rule.write")).toBe(role === "owner");
      expect(actorHasPermission(user, role, "operator_grant.manage")).toBe(role === "owner");
    }
  });

  it("does not let field employees or accountants write records", () => {
    for (const role of ["field_employee", "accountant_readonly"] as const) {
      expect(actorHasPermission(user, role, "customer.write")).toBe(false);
      expect(actorHasPermission(user, role, "job.write")).toBe(false);
      expect(actorHasPermission(user, role, "approval.decide")).toBe(false);
    }
  });

  it("limits agents to green actions", () => {
    const agent: Actor = { type: "agent", name: "receptionist" };
    expect(actorHasPermission(agent, null, "task.create")).toBe(true);
    expect(actorHasPermission(agent, null, "approval.request")).toBe(true);
    expect(actorHasPermission(agent, null, "approval.decide")).toBe(false);
    expect(actorHasPermission(agent, null, "customer.read")).toBe(false);
  });

  it("gives internal operators nothing through the tenant matrix", () => {
    const op: Actor = { type: "internal_operator", userId: "00000000-0000-4000-8000-000000000003" };
    expect(actorHasPermission(op, "owner", "customer.read")).toBe(false);
  });

  it("denies users without a membership", () => {
    expect(actorHasPermission(user, null, "org.read")).toBe(false);
  });
});
