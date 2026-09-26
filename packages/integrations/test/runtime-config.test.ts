import { describe, expect, it } from "vitest";
import {
  createProviderRuntime,
  FakeSmsProvider,
  FakeVoiceProvider,
  ProviderConfigError,
  TwilioSmsProvider,
  VapiVoiceProvider,
  type ProviderEnv,
} from "../src";

const live: ProviderEnv = {
  TWILIO_ACCOUNT_SID: `AC${"0123456789abcdef".repeat(2)}`, // fake; built at runtime
  TWILIO_AUTH_TOKEN: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  TWILIO_WEBHOOK_URL: "https://app.acme.test/api/webhooks/sms",
  VAPI_API_KEY: "3c1f9a7e-5b2d-4e8f-a6c0-9d1b2e3f4a5b",
  VAPI_WEBHOOK_SECRET: "q7Hs0Lr2Vx9Nc4Pz8Kw1Mj6Tb3Yd5Ge0",
};

describe("provider runtime selection", () => {
  it("development defaults to fakes, but only with an explicit webhook secret", () => {
    expect(() => createProviderRuntime({ NODE_ENV: "development" })).toThrow(ProviderConfigError);
    const rt = createProviderRuntime({
      NODE_ENV: "development",
      FAKE_PROVIDER_WEBHOOK_SECRET: "a-local-dev-secret-123",
    });
    expect(rt.mode).toBe("fake");
    expect(rt.sms).toBeInstanceOf(FakeSmsProvider);
    expect(rt.voice).toBeInstanceOf(FakeVoiceProvider);
  });

  it("fakes cannot be constructed without a secret (no hard-coded defaults)", () => {
    expect(() => new FakeSmsProvider("")).toThrow(/explicit webhook secret/);
    expect(() => new FakeVoiceProvider("short")).toThrow(/explicit webhook secret/);
  });

  it("production refuses fakes outright", () => {
    expect(() =>
      createProviderRuntime({
        NODE_ENV: "production",
        BO_PROVIDER_MODE: "fake",
        FAKE_PROVIDER_WEBHOOK_SECRET: "a-local-dev-secret-123",
      }),
    ).toThrow(/not allowed when NODE_ENV=production/);
  });

  it("production with no provider settings fails closed and names what is missing", () => {
    const err = (() => {
      try {
        createProviderRuntime({ NODE_ENV: "production" });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ProviderConfigError);
    expect(err?.message).toMatch(/TWILIO_ACCOUNT_SID.*VAPI_WEBHOOK_SECRET/);
  });

  it.each([
    ["the old public fake secret", { VAPI_WEBHOOK_SECRET: "fake-voice-webhook-secret" }],
    ["a placeholder", { TWILIO_AUTH_TOKEN: "replace-me-with-real-token-000" }],
    ["a too-short secret", { VAPI_WEBHOOK_SECRET: "abc" }],
    ["a malformed account sid", { TWILIO_ACCOUNT_SID: "not-a-sid" }],
    ["http webhook URL", { TWILIO_WEBHOOK_URL: "http://app.acme.test/api/webhooks/sms" }],
    [
      "query string on the webhook URL",
      { TWILIO_WEBHOOK_URL: "https://app.acme.test/api/webhooks/sms?x=1" },
    ],
  ])("production rejects %s", (_name, override) => {
    expect(() => createProviderRuntime({ NODE_ENV: "production", ...live, ...override })).toThrow(
      ProviderConfigError,
    );
  });

  it("error messages never include secret values", () => {
    try {
      createProviderRuntime({
        NODE_ENV: "production",
        ...live,
        VAPI_WEBHOOK_SECRET: "fake-voice-webhook-secret",
      });
    } catch (e) {
      expect((e as Error).message).not.toContain("fake-voice-webhook-secret");
      expect((e as Error).message).not.toContain(live.TWILIO_AUTH_TOKEN);
    }
  });

  it("production with complete, real-looking settings builds the real adapters", () => {
    const rt = createProviderRuntime({ NODE_ENV: "production", ...live });
    expect(rt.mode).toBe("live");
    expect(rt.sms).toBeInstanceOf(TwilioSmsProvider);
    expect(rt.voice).toBeInstanceOf(VapiVoiceProvider);
  });
});
