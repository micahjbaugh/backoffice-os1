// Provider SDKs live only inside this package (CLAUDE.md rule 9).
// Adapter implementations are added in later M2 tasks.
export const INTEGRATIONS_PACKAGE = "@backoffice/integrations";

export * from "./providers/voice-provider";
export * from "./providers/sms-provider";
export * from "./fakes/fake-voice-provider";
export * from "./fakes/fake-sms-provider";
