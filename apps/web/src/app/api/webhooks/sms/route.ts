import { providerRuntime } from "@/server/providers";
import { handleProviderWebhook } from "@/server/webhook-route";
import { createWebhookHandlers } from "@backoffice/workflows";

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook(() => providerRuntime().sms, request, {
    selectHandlers: () => createWebhookHandlers(providerRuntime().extractor),
  });
}
