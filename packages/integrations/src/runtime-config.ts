// Which provider adapters the app runs with, decided from environment variables.
//
//   production (NODE_ENV=production): real providers only, fully configured, with real secrets.
//     Fake providers, missing settings, placeholder/known-fake secrets and non-HTTPS webhook URLs
//     are configuration errors. Callers treat them as "provider unavailable" (fail closed).
//   elsewhere: fake providers by default, but only with an explicit webhook secret; real providers
//     when BO_PROVIDER_MODE=live and fully configured.
// Error messages name missing settings, never their values.

import type { FieldCaptureExtraction, StructuredExtractor } from "@backoffice/domain";
import { AnthropicStructuredExtractor } from "./adapters/anthropic-structured-extractor";
import { TwilioSmsProvider } from "./adapters/twilio-sms-provider";
import { VapiVoiceProvider } from "./adapters/vapi-voice-provider";
import { FakeSmsProvider } from "./fakes/fake-sms-provider";
import { FakeVoiceProvider } from "./fakes/fake-voice-provider";
import { MIN_FAKE_SECRET_LENGTH } from "./fakes/fake-webhooks";
import { FixtureStructuredExtractor } from "./fakes/fixture-structured-extractor";
import type { SmsProvider } from "./providers/sms-provider";
import type { VoiceProvider } from "./providers/voice-provider";

export interface ProviderEnv {
  NODE_ENV?: string;
  BO_PROVIDER_MODE?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WEBHOOK_URL?: string;
  VAPI_API_KEY?: string;
  VAPI_WEBHOOK_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  FAKE_PROVIDER_WEBHOOK_SECRET?: string;
}

export interface ProviderRuntime {
  mode: "live" | "fake";
  sms: SmsProvider;
  voice: VoiceProvider;
  /** Field capture's structured extractor (M3-T16): the fixture in fake mode, Anthropic in live mode. */
  extractor: StructuredExtractor<FieldCaptureExtraction>;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** Secrets that have appeared in this public repository or are obvious placeholders. */
export const KNOWN_UNSAFE_SECRETS: ReadonlySet<string> = new Set([
  "fake-sms-webhook-secret",
  "fake-voice-webhook-secret",
  "replace-with-anon-key",
  "changeme",
  "secret",
  "test",
]);
const UNSAFE_SECRET_PATTERN = /fake|placeholder|changeme|example|replace[-_]?me|dummy/i;
const MIN_LIVE_SECRET_LENGTH = 16;

function unsafeSecret(value: string): boolean {
  return KNOWN_UNSAFE_SECRETS.has(value.toLowerCase()) || UNSAFE_SECRET_PATTERN.test(value);
}

export function createProviderRuntime(env: ProviderEnv): ProviderRuntime {
  const production = env.NODE_ENV === "production";
  const mode = env.BO_PROVIDER_MODE ?? (production ? "live" : "fake");
  if (mode !== "live" && mode !== "fake") {
    throw new ProviderConfigError(`BO_PROVIDER_MODE must be "live" or "fake"`);
  }
  if (production && mode !== "live") {
    throw new ProviderConfigError("fake providers are not allowed when NODE_ENV=production");
  }

  if (mode === "fake") {
    const secret = env.FAKE_PROVIDER_WEBHOOK_SECRET;
    if (!secret || secret.length < MIN_FAKE_SECRET_LENGTH) {
      throw new ProviderConfigError(
        `fake providers need FAKE_PROVIDER_WEBHOOK_SECRET (at least ${MIN_FAKE_SECRET_LENGTH} characters)`,
      );
    }
    return {
      mode,
      sms: new FakeSmsProvider(secret),
      voice: new FakeVoiceProvider(secret),
      extractor: new FixtureStructuredExtractor(),
    };
  }

  const required = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_WEBHOOK_URL",
    "VAPI_API_KEY",
    "VAPI_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
  ] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new ProviderConfigError(`live providers need: ${missing.join(", ")}`);

  const problems: string[] = [];
  if (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID ?? ""))
    problems.push("TWILIO_ACCOUNT_SID is not an Account SID");
  for (const name of [
    "TWILIO_AUTH_TOKEN",
    "VAPI_API_KEY",
    "VAPI_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
  ] as const) {
    const value = env[name] ?? "";
    if (value.length < MIN_LIVE_SECRET_LENGTH) problems.push(`${name} is too short`);
    else if (unsafeSecret(value))
      problems.push(`${name} looks like a placeholder or known test value`);
  }
  let webhookUrl: URL | null = null;
  try {
    webhookUrl = new URL(env.TWILIO_WEBHOOK_URL ?? "");
  } catch {
    problems.push("TWILIO_WEBHOOK_URL is not a URL");
  }
  if (webhookUrl && production && webhookUrl.protocol !== "https:")
    problems.push("TWILIO_WEBHOOK_URL must be https in production");
  if (webhookUrl?.search) problems.push("TWILIO_WEBHOOK_URL must not include a query string");
  if (problems.length)
    throw new ProviderConfigError(`live provider configuration is invalid: ${problems.join("; ")}`);

  return {
    mode,
    sms: new TwilioSmsProvider({
      accountSid: env.TWILIO_ACCOUNT_SID as string,
      authToken: env.TWILIO_AUTH_TOKEN as string,
      webhookUrl: (webhookUrl as URL).toString().replace(/\/$/, ""),
    }),
    voice: new VapiVoiceProvider({
      apiKey: env.VAPI_API_KEY as string,
      webhookSecret: env.VAPI_WEBHOOK_SECRET as string,
    }),
    extractor: new AnthropicStructuredExtractor({
      apiKey: env.ANTHROPIC_API_KEY as string,
      model: env.ANTHROPIC_MODEL,
    }),
  };
}
