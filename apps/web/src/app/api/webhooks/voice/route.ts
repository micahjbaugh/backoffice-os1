import { db } from "@/server/db";
import { providerRuntime } from "@/server/providers";
import { handleProviderWebhook } from "@/server/webhook-route";
import { resolveAssistantTurn } from "@backoffice/workflows";

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook(() => providerRuntime().voice, request, {
    // M2-T19: only assistant-request has a receptionist runtime so far; tool-calls and
    // transfer-destination-request (M2-T20/T21) fall through to the default acknowledgement.
    answerSynchronousEvent: async (event) => {
      if (event.eventType !== "call.assistant_request") return null;
      const turn = await resolveAssistantTurn(db(), {
        provider: event.provider,
        routingAddress: event.routingAddress,
      });
      return providerRuntime().voice.buildAssistantResponse(turn);
    },
  });
}
