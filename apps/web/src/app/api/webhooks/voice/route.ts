import { db } from "@/server/db";
import { providerRuntime } from "@/server/providers";
import { handleProviderWebhook } from "@/server/webhook-route";
import { executeReceptionistToolCalls, resolveAssistantTurn } from "@backoffice/workflows";

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook(() => providerRuntime().voice, request, {
    // M2-T19/T20: assistant-request and tool-calls are answered here; transfer-destination-request
    // (M2-T21) still falls through to the default acknowledgement.
    answerSynchronousEvent: async (event) => {
      if (event.eventType === "call.assistant_request") {
        const turn = await resolveAssistantTurn(db(), {
          provider: event.provider,
          routingAddress: event.routingAddress,
        });
        return providerRuntime().voice.buildAssistantResponse(turn);
      }
      if (event.eventType === "call.tool_calls") {
        const results = await executeReceptionistToolCalls(db(), {
          provider: event.provider,
          routingAddress: event.routingAddress,
          callId: event.resourceId,
          customerNumber: str(event.payload.customerNumber),
          businessNumber: str(event.payload.phoneNumber),
          toolCalls: event.toolCalls ?? [],
        });
        return providerRuntime().voice.buildToolCallResponse(results);
      }
      return null;
    },
  });
}
