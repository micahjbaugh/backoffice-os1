// Provider SDKs and provider HTTP live only inside this package (CLAUDE.md rule 9).
export const INTEGRATIONS_PACKAGE = "@backoffice/integrations";

export * from "./webhooks";
export * from "./outcomes";
export * from "./webhook-signing";
export * from "./providers/voice-provider";
export * from "./providers/sms-provider";
export * from "./fakes/fake-webhooks";
export * from "./fakes/fake-sms-provider";
export * from "./fakes/fake-voice-provider";
export * from "./fakes/fixture-structured-extractor";
export * from "./adapters/twilio-sms-provider";
export * from "./adapters/vapi-voice-provider";
export * from "./adapters/anthropic-structured-extractor";
export * from "./runtime-config";
