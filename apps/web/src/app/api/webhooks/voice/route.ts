import { db } from "@/server/db";
import { providerRuntime } from "@/server/providers";
import { handleProviderWebhook } from "@/server/webhook-route";
import {
  executeReceptionistToolCalls,
  resolveAssistantTurn,
  resolveTransferDestination,
} from "@backoffice/workflows";

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook(() => providerRuntime().voice, request, {
    // M2-T19/T20/T21: assistant-request, tool-calls and transfer-destination-request are all
    // answered here, synchronously, within Vapi's response window.
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
      if (event.eventType === "call.transfer_destination_request") {
        const destination = await resolveTransferDestination(db(), {
          provider: event.provider,
          routingAddress: event.routingAddress,
          callId: event.resourceId,
          customerNumber: str(event.payload.customerNumber),
          businessNumber: str(event.payload.phoneNumber),
        });
        return providerRuntime().voice.buildTransferDestinationResponse(destination);
      }
      return null;
    },
  });
}
