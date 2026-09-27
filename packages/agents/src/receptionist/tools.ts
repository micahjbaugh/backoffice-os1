import { BUSINESS_INFO_TOPICS, createCallbackTaskInput, createLeadInput } from "@backoffice/domain";
import { z } from "zod";
import type { ToolContract } from "../tool-contract";

/**
 * Read-only lookup of tenant-configured, caller-safe business info. Never returns a price or a
 * committed schedule date (ARCHITECTURE.md §13) — those require configured authority beyond this
 * agent's reach.
 */
export const lookupBusinessInfoInput = z.object({
  topic: z.enum(BUSINESS_INFO_TOPICS),
});

export const requestTransferInput = z.object({
  communicationId: z.uuid(),
  reason: z.enum([
    "caller_requested_human",
    "uncertain_intake",
    "outside_permitted_topics",
    "provider_failure",
  ]),
  note: z.string().trim().max(500).optional(),
});

/**
 * Bounded tool set for the receptionist agent (M2_READINESS.md item 5): permitted business
 * lookup, draft lead creation, callback/task creation and transfer requests. Every entry is
 * "green" (MASTER_SPEC.md §8) because non-human actors are restricted to green permissions
 * server-side (packages/domain/permissions.ts AUTOMATED_PERMISSIONS) — none may commit a price,
 * a schedule date, or an approval decision.
 */
export const receptionistTools: Readonly<Record<string, ToolContract>> = {
  lookup_business_info: {
    name: "lookup_business_info",
    description:
      "Look up tenant-configured, caller-safe business info such as hours, services, service area or address.",
    riskClass: "green",
    inputSchema: lookupBusinessInfoInput,
  },
  create_lead: {
    name: "create_lead",
    description:
      "Create a draft lead from caller-provided details. Never invents a price or a committed schedule date.",
    riskClass: "green",
    inputSchema: createLeadInput,
  },
  create_callback_task: {
    name: "create_callback_task",
    description: "Create a callback/follow-up task linked to the current call or message.",
    riskClass: "green",
    inputSchema: createCallbackTaskInput,
  },
  request_transfer: {
    name: "request_transfer",
    description:
      "Request a warm transfer to a human — the caller asked for a person, intake is uncertain, or the request is outside permitted topics.",
    riskClass: "green",
    inputSchema: requestTransferInput,
  },
};
