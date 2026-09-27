// M2-T19: the receptionist runtime for Vapi's synchronous assistant-request. Resolves the tenant's
// configuration (packages/core) into a provider-independent AssistantTurn (packages/integrations),
// using the receptionist agent's versioned prompt and tool contracts (packages/agents). An unknown
// number or a tenant with no active configuration gets the same safe fallback turn — no tools, no
// business identity disclosed — instead of guessing (CLAUDE.md rule 14).

import {
  receptionistAgent,
  receptionistGreeting,
  receptionistTools,
  RECEPTIONIST_FALLBACK_MESSAGE,
  RECEPTIONIST_FALLBACK_PROMPT,
  renderPrompt,
  type ToolContract,
} from "@backoffice/agents";
import {
  createCallbackTask,
  createLead,
  createOpsCase,
  inTenant,
  lookupBusinessInfo,
  recordCall,
  resolveReceptionistConfig,
  runAs,
  type Database,
  type ServiceContext,
} from "@backoffice/core";
import {
  ForbiddenError,
  NotFoundError,
  TRANSFER_REASONS,
  ValidationError,
  type Actor,
  type BusinessInfoTopic,
  type CreateCallbackTaskInput,
  type CreateLeadInput,
  type OpsCaseReasonCode,
  type TransferReason,
  type UUID,
} from "@backoffice/domain";
import type {
  AssistantToolDescriptor,
  AssistantTurn,
  ToolCallResult,
} from "@backoffice/integrations";
import { z } from "zod";

export const RECEPTIONIST_RUNTIME: Actor = { type: "system", name: "receptionist-runtime" };
/**
 * Executes receptionist tool calls (M2-T20): green-permission-only (packages/domain/permissions.ts
 * AUTOMATED_PERMISSIONS), distinct from RECEPTIONIST_RUNTIME above which resolves tenant/config and
 * needs broader reads. Every mutation this actor makes is attributed to it in the audit trail.
 */
export const RECEPTIONIST_AGENT: Actor = { type: "agent", name: "receptionist" };

const FALLBACK_TURN: AssistantTurn = {
  systemPrompt: RECEPTIONIST_FALLBACK_PROMPT.template,
  firstMessage: RECEPTIONIST_FALLBACK_MESSAGE,
  tools: [],
};

function toolDescriptor(tool: ToolContract): AssistantToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    // "any": some domain inputs normalize values (e.g. lowercasing an email) via `.transform`,
    // which has no JSON Schema equivalent. This schema only guides the model's function call;
    // the domain input schema is still the one that validates and normalizes server-side.
    parameters: z.toJSONSchema(tool.inputSchema, { unrepresentable: "any" }) as Record<
      string,
      unknown
    >,
  };
}

/**
 * Resolve the tenant's receptionist configuration into the turn Vapi's assistant-request needs,
 * within its synchronous time budget: one transaction, no outbound provider calls.
 */
export async function resolveAssistantTurn(
  db: Database,
  params: { provider: string; routingAddress: string | null },
): Promise<AssistantTurn> {
  const resolution = await runAs(db, RECEPTIONIST_RUNTIME, (tx) =>
    resolveReceptionistConfig(tx, params),
  );
  if (resolution.status !== "resolved") return FALLBACK_TURN;

  return {
    systemPrompt: renderPrompt(receptionistAgent.prompt, {
      business_name: resolution.businessName,
      business_hours: resolution.businessHours,
    }),
    firstMessage: receptionistGreeting(resolution.businessName),
    tools: Object.values(receptionistAgent.tools).map(toolDescriptor),
  };
}

const NOT_AVAILABLE_RESULT = "Sorry, I can't help with that right now.";

/** The model has no legitimate way to know these UUIDs; the server always supplies them itself. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** request_transfer isn't a live transfer (that's M2-T21); it escalates to the human backstop. */
const TRANSFER_REASON_TO_OPS_CASE: Record<TransferReason, OpsCaseReasonCode> = {
  caller_requested_human: "caller_requested_human",
  uncertain_intake: "low_confidence",
  outside_permitted_topics: "policy_conflict",
  provider_failure: "integration_failure",
};
const requestTransferArgs = z.object({
  reason: z.enum(TRANSFER_REASONS),
  note: z.string().trim().max(500).optional(),
});

/**
 * Execute one tool call through the domain service it names. Validation/authorization/entity-scope
 * failures become a safe spoken result instead of a thrown error, so one bad tool call in a batch
 * doesn't abort the others; anything else (a real bug or DB error) propagates so Vapi retries the
 * whole batch — safe, since every mutation below is idempotent per `call.id`.
 */
async function executeToolCall(
  ctx: ServiceContext,
  communicationId: UUID,
  call: { id: string; name: string; arguments: unknown },
): Promise<string> {
  const idempotencyKey = `vapi:tool_call:${call.id}`;
  try {
    switch (call.name) {
      case "lookup_business_info": {
        const parsed = receptionistTools.lookup_business_info?.inputSchema.safeParse(
          call.arguments,
        );
        if (!parsed?.success) return NOT_AVAILABLE_RESULT;
        const topic = (parsed.data as { topic: BusinessInfoTopic }).topic;
        const value = await lookupBusinessInfo(ctx, topic);
        return value ?? "I don't have that information available right now.";
      }
      case "create_lead": {
        const { lead } = await createLead(ctx, {
          ...asRecord(call.arguments),
          originatingCommunicationId: communicationId,
          idempotencyKey,
        } as CreateLeadInput);
        return `Got it — I've logged this as a new lead (reference ${lead.id.slice(0, 8)}).`;
      }
      case "create_callback_task": {
        const task = await createCallbackTask(ctx, {
          ...asRecord(call.arguments),
          communicationId,
          idempotencyKey,
        } as CreateCallbackTaskInput);
        return `I've scheduled a callback task (reference ${task.id.slice(0, 8)}).`;
      }
      case "request_transfer": {
        const parsed = requestTransferArgs.safeParse(call.arguments);
        const reason: TransferReason = parsed.success
          ? parsed.data.reason
          : "caller_requested_human";
        await createOpsCase(ctx, {
          title: "Caller requested a transfer during an inbound call",
          reasonCode: TRANSFER_REASON_TO_OPS_CASE[reason],
          priority: "high",
          entityType: "communication",
          entityId: communicationId,
          evidence: {
            tool_call_id: call.id,
            reason,
            note: parsed.success ? (parsed.data.note ?? null) : null,
          },
        });
        return "I've flagged this for a team member to call you back shortly.";
      }
      default:
        return NOT_AVAILABLE_RESULT;
    }
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NOT_AVAILABLE_RESULT;
    }
    throw error;
  }
}

/**
 * Answer Vapi's synchronous tool-calls webhook (M2-T20): resolve the tenant (one transaction, same
 * as resolveAssistantTurn), then execute every requested tool as the receptionist agent actor in a
 * second transaction. Each result is keyed by the provider's own toolCallId so a redelivered batch
 * re-executes safely — every mutation is idempotent on `vapi:tool_call:${toolCallId}`.
 */
export async function executeReceptionistToolCalls(
  db: Database,
  params: {
    provider: string;
    routingAddress: string | null;
    callId: string;
    customerNumber: string | null;
    businessNumber: string | null;
    toolCalls: readonly { id: string; name: string; arguments: unknown }[];
  },
): Promise<ToolCallResult[]> {
  const resolution = await runAs(db, RECEPTIONIST_RUNTIME, (tx) =>
    resolveReceptionistConfig(tx, {
      provider: params.provider,
      routingAddress: params.routingAddress,
    }),
  );
  if (resolution.status !== "resolved") {
    return params.toolCalls.map((call) => ({ toolCallId: call.id, result: NOT_AVAILABLE_RESULT }));
  }
  const organizationId = resolution.organizationId;

  return runAs(db, RECEPTIONIST_AGENT, async (tx) => {
    const ctx = inTenant(tx, organizationId);
    const { communication } = await recordCall(ctx, {
      direction: "inbound",
      provider: params.provider,
      providerConversationId: params.callId,
      status: "in_progress",
      fromNumber: params.customerNumber ?? undefined,
      toNumber: params.businessNumber ?? undefined,
    });

    const results: ToolCallResult[] = [];
    for (const call of params.toolCalls) {
      results.push({
        toolCallId: call.id,
        result: await executeToolCall(ctx, communication.id, call),
      });
    }
    return results;
  });
}
