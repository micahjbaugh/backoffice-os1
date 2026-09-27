import "server-only";

import { createProviderRuntime, type ProviderRuntime } from "@backoffice/integrations";

// Provider adapters for this process, chosen from environment variables by the rules in
// @backoffice/integrations/runtime-config: production requires fully configured real providers with
// real secrets and refuses fakes; development uses fakes only with an explicit
// FAKE_PROVIDER_WEBHOOK_SECRET. A configuration error is thrown on use (callers answer 503), so a
// misconfigured deployment fails closed instead of accepting forged webhooks.
const globalForProviders = globalThis as unknown as { backofficeProviderRuntime?: ProviderRuntime };

export function providerRuntime(): ProviderRuntime {
  globalForProviders.backofficeProviderRuntime ??= createProviderRuntime(process.env);
  return globalForProviders.backofficeProviderRuntime;
}
