import { smsProvider } from "@/server/providers";
import { handleProviderWebhook } from "@/server/webhook-route";

export async function POST(request: Request): Promise<Response> {
  return handleProviderWebhook(smsProvider(), request);
}
