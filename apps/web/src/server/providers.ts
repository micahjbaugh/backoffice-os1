import "server-only";

import { FakeSmsProvider, FakeVoiceProvider, type SmsProvider, type VoiceProvider } from "@backoffice/integrations";

// Real provider adapters (Twilio, Vapi, ...) are wired behind these accessors in a later M2 task.
// Fakes keep the webhook route runnable end-to-end today; provider SDKs stay out of app code
// either way (CLAUDE.md rule 9).
const globalForProviders = globalThis as unknown as {
  backofficeVoiceProvider?: VoiceProvider;
  backofficeSmsProvider?: SmsProvider;
};

export function voiceProvider(): VoiceProvider {
  globalForProviders.backofficeVoiceProvider ??= new FakeVoiceProvider();
  return globalForProviders.backofficeVoiceProvider;
}

export function smsProvider(): SmsProvider {
  globalForProviders.backofficeSmsProvider ??= new FakeSmsProvider();
  return globalForProviders.backofficeSmsProvider;
}
