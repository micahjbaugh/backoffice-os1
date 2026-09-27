"use server";

// Owner Inbox / tenant server actions. Every exported function here is a publicly reachable
// endpoint, so each one authenticates (withTenant) and the service layer authorizes. The
// organization always comes from the validated session, never from form input.
//
// Deliberately NOT exposed here: recordEvent / writeAudit. They are server-internal and invoked by
// the services below inside the same transaction; a client-callable "write audit" would allow forgery.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  addMember,
  addNote,
  createApproval,
  createApprovalRuleVersion,
  createCustomer,
  createEmployee,
  createJob,
  createOpsCase,
  createTask,
  createVendor,
  deactivateProviderRoute,
  decideApproval,
  decideBillableOpportunity,
  decideOpsCase,
  grantOperatorAccess,
  registerProviderRoute,
  retireRule,
  revokeOperatorAccess,
  updateJob,
  updateTaskStatus,
} from "@backoffice/core";
import type { ActionState } from "@/lib/action-state";
import { dateTimeLocalToIso, dollarsToCents, field, runAction } from "@/server/actions";
import { getUserSession, ORG_COOKIE, ORG_COOKIE_OPTIONS, withTenant } from "@/server/session";

export async function selectOrganizationAction(form: FormData): Promise<void> {
  const orgId = field(form, "organizationId");
  const session = await getUserSession();
  if (orgId && session.organizations.some((o) => o.organization.id === orgId)) {
    (await cookies()).set(ORG_COOKIE, orgId, ORG_COOKIE_OPTIONS);
  }
  redirect("/inbox");
}

// --- Inbox: approvals -------------------------------------------------------

export async function decideApprovalAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const decision = field(form, "decision") === "approved" ? "approved" : "rejected";
    const { replayed } = await withTenant((ctx) =>
      decideApproval(ctx, {
        approvalId: field(form, "approvalId") ?? "",
        decision,
        note: field(form, "note"),
      }),
    );
    if (replayed) return `Already ${decision}. Nothing was repeated.`;
    return decision === "approved" ? "Approved." : "Rejected.";
  }, ["/inbox"]);
}

export async function decideBillableOpportunityAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const decision = field(form, "decision") === "approved" ? "approved" : "dismissed";
    const { replayed } = await withTenant((ctx) =>
      decideBillableOpportunity(ctx, {
        id: field(form, "billableOpportunityId") ?? "",
        decision,
        note: field(form, "note"),
      }),
    );
    if (replayed) return `Already ${decision}. Nothing was repeated.`;
    return decision === "approved" ? "Approved as billable." : "Dismissed.";
  }, ["/inbox"]);
}

// --- Inbox: clarifications (ops cases) ---------------------------------------

export async function decideOpsCaseAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const decision = field(form, "decision") === "resolved" ? "resolved" : "dismissed";
    const { replayed } = await withTenant((ctx) =>
      decideOpsCase(ctx, {
        id: field(form, "opsCaseId") ?? "",
        decision,
        note: field(form, "note"),
      }),
    );
    if (replayed) return `Already ${decision}. Nothing was repeated.`;
    return decision === "resolved" ? "Marked resolved." : "Dismissed.";
  }, ["/inbox"]);
}

export async function addNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      addNote(ctx, {
        entityType: (field(form, "entityType") ?? "approval") as "approval",
        entityId: field(form, "entityId") ?? "",
        body: field(form, "body") ?? "",
      }),
    );
    return "Note added.";
  }, ["/inbox"]);
}

export async function createApprovalAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const { created } = await withTenant((ctx) =>
      createApproval(ctx, {
        type: field(form, "type") ?? "",
        title: field(form, "title") ?? "",
        description: field(form, "description"),
        amountCents: dollarsToCents(field(form, "amount")),
        // Generated when the form rendered: a double submit reuses it and creates nothing new.
        idempotencyKey: field(form, "idempotencyKey") ?? "",
      }),
    );
    return created ? "Approval requested." : "That request was already submitted.";
  }, ["/inbox"]);
}

// --- Inbox: tasks and escalation ---------------------------------------------

export async function createTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      createTask(ctx, {
        title: field(form, "title") ?? "",
        description: field(form, "description"),
        priority: (field(form, "priority") ?? "normal") as "normal",
        dueAt: dateTimeLocalToIso(field(form, "dueAt")),
      }),
    );
    return "Task created.";
  }, ["/inbox"]);
}

export async function completeTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) => updateTaskStatus(ctx, field(form, "taskId") ?? "", "done"));
    return "Task completed.";
  }, ["/inbox"]);
}

export async function createOpsCaseAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      createOpsCase(ctx, {
        title: field(form, "title") ?? "",
        reasonCode: (field(form, "reasonCode") ?? "other") as "other",
        priority: (field(form, "priority") ?? "normal") as "normal",
        evidence: { details: field(form, "details") ?? null, source: "owner_inbox" },
      }),
    );
    return "Sent to the Back Office team.";
  }, ["/inbox"]);
}

// --- Records ------------------------------------------------------------------

export async function createCustomerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      createCustomer(ctx, {
        displayName: field(form, "displayName") ?? "",
        phone: field(form, "phone"),
        email: field(form, "email"),
        notes: field(form, "notes"),
      }),
    );
    return "Customer added.";
  }, ["/customers"]);
}

export async function createVendorAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      createVendor(ctx, {
        displayName: field(form, "displayName") ?? "",
        phone: field(form, "phone"),
        email: field(form, "email"),
        preferred: form.get("preferred") === "on",
      }),
    );
    return "Vendor added.";
  }, ["/vendors"]);
}

export async function createEmployeeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      createEmployee(ctx, {
        displayName: field(form, "displayName") ?? "",
        phone: field(form, "phone"),
        email: field(form, "email"),
      }),
    );
    return "Employee added.";
  }, ["/settings"]);
}

export async function createJobAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      createJob(ctx, {
        name: field(form, "name") ?? "",
        customerId: field(form, "customerId"),
        scheduledStart: dateTimeLocalToIso(field(form, "scheduledStart")),
      }),
    );
    return "Job created.";
  }, ["/jobs"]);
}

export async function updateJobStatusAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      updateJob(ctx, field(form, "jobId") ?? "", {
        status: field(form, "status") as "draft" | undefined,
      }),
    );
    return "Job updated.";
  }, ["/jobs"]);
}

// --- Settings -------------------------------------------------------------------

export async function addMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      addMember(ctx, {
        email: field(form, "email") ?? "",
        role: (field(form, "role") ?? "") as "manager",
      }),
    );
    return "Member added.";
  }, ["/settings"]);
}

export async function createApprovalRuleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const types = field(form, "approvalTypes");
    const rule = await withTenant((ctx) =>
      createApprovalRuleVersion(ctx, {
        ruleKey: field(form, "ruleKey") ?? "",
        roles: ["office_admin"],
        approvalTypes: types
          ? types
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
        maxAmountCents: dollarsToCents(field(form, "maxAmount")),
      }),
    );
    return `Rule saved as version ${rule.version}.`;
  }, ["/settings"]);
}

export async function retireRuleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) => retireRule(ctx, field(form, "ruleId") ?? ""));
    return "Rule retired.";
  }, ["/settings"]);
}

export async function grantOperatorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) =>
      grantOperatorAccess(ctx, {
        operatorEmail: field(form, "operatorEmail") ?? "",
        reason: field(form, "reason") ?? "",
        durationHours: Number(field(form, "durationHours") ?? "24"),
      }),
    );
    return "Access granted.";
  }, ["/settings"]);
}

export async function revokeOperatorAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) => revokeOperatorAccess(ctx, field(form, "grantId") ?? ""));
    return "Access revoked.";
  }, ["/settings"]);
}

// twilio only ships an SmsProvider adapter and vapi only a VoiceProvider one (packages/integrations),
// so the channel is implied by the provider rather than a separate form field.
const PROVIDER_ROUTE_CHANNEL: Record<string, "sms" | "voice"> = { twilio: "sms", vapi: "voice" };

export async function registerProviderRouteAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const provider = field(form, "provider") ?? "";
    const { requeuedEvents } = await withTenant((ctx) =>
      registerProviderRoute(ctx, {
        provider: provider as "twilio",
        channel: PROVIDER_ROUTE_CHANNEL[provider] ?? "sms",
        address: field(form, "address") ?? "",
      }),
    );
    return requeuedEvents > 0
      ? `Number registered. ${requeuedEvents} held message(s) are now being processed.`
      : "Number registered.";
  }, ["/settings"]);
}

export async function deactivateProviderRouteAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await withTenant((ctx) => deactivateProviderRoute(ctx, field(form, "routeId") ?? ""));
    return "Number deactivated.";
  }, ["/settings"]);
}
