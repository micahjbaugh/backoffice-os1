// M2-T19: the receptionist runtime for Vapi's synchronous assistant-request. Resolves the tenant's
// configuration (packages/core) into a provider-independent AssistantTurn (packages/integrations),
// using the receptionist agent's versioned prompt and tool contracts (packages/agents). An unknown
// number or a tenant with no active configuration gets the same safe fallback turn — no tools, no
// business identity disclosed — instead of guessing (CLAUDE.md rule 14).

import {
  receptionistAgent,
  receptionistGreeting,
  RECEPTIONIST_FALLBACK_MESSAGE,
  RECEPTIONIST_FALLBACK_PROMPT,
  renderPrompt,
  type ToolContract,
} from "@backoffice/agents";
import { resolveReceptionistConfig, runAs, type Database } from "@backoffice/core";
import type { Actor } from "@backoffice/domain";
import type { AssistantToolDescriptor, AssistantTurn } from "@backoffice/integrations";
import { z } from "zod";

export const RECEPTIONIST_RUNTIME: Actor = { type: "system", name: "receptionist-runtime" };

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
