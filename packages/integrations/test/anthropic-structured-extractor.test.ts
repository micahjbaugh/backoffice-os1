import { fieldCaptureExtractionSchema } from "@backoffice/domain";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicStructuredExtractor,
  anthropicStructuredExtractorFromEnv,
  FIELD_CAPTURE_ACCEPTANCE_EXTRACTION,
  FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
  FIELD_CAPTURE_PROMPT_VERSION,
  ProviderConfigError,
  ProviderRequestError,
} from "../src";

const TOOL_NAME = "record_field_capture_extraction";
const INPUT = { organizationId: "org-1", sourceCommunicationId: "comm-1", text: "hi" };

const extractor = (fetchFn?: typeof fetch) =>
  new AnthropicStructuredExtractor({ apiKey: "sk-ant-test-key-0000000000", fetchFn });

const toolUseResponse = (input: unknown, status = 200) =>
  // A fresh Response per call: a body can only be read once.
  vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "tool_use", id: "toolu_1", name: TOOL_NAME, input }],
        }),
        { status },
      ),
  );

describe("AnthropicStructuredExtractor", () => {
  it("sends the versioned system prompt, forces the extraction tool, and returns the parsed data", async () => {
    const fetchFn = toolUseResponse(FIELD_CAPTURE_ACCEPTANCE_EXTRACTION);
    const result = await extractor(fetchFn).extract({
      organizationId: "org-1",
      sourceCommunicationId: "comm-1",
      text: FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
    });

    expect(fieldCaptureExtractionSchema.safeParse(result.data).success).toBe(true);
    expect(result.data).toEqual(FIELD_CAPTURE_ACCEPTANCE_EXTRACTION);
    expect(result.modelVersion).toBe(`anthropic:claude-sonnet-5:${FIELD_CAPTURE_PROMPT_VERSION}`);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(
      "sk-ant-test-key-0000000000",
    );
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.system).toContain(TOOL_NAME);
    expect(body.tool_choice).toEqual({ type: "tool", name: TOOL_NAME });
    expect(body.messages).toEqual([{ role: "user", content: FIELD_CAPTURE_ACCEPTANCE_MESSAGE }]);
    const tools = body.tools as Array<{ name: string; input_schema: { properties?: object } }>;
    expect(tools[0]?.name).toBe(TOOL_NAME);
    expect(tools[0]?.input_schema.properties).toHaveProperty("facts");
  });

  it("uses a configured model and base URL instead of the defaults", async () => {
    const fetchFn = toolUseResponse({ facts: [], unresolvedQuestions: [] });
    const custom = new AnthropicStructuredExtractor({
      apiKey: "key",
      model: "claude-haiku-4-5-20251001",
      apiBaseUrl: "https://internal.example/anthropic",
      fetchFn,
    });
    await custom.extract(INPUT);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://internal.example/anthropic/v1/messages");
    expect(custom.modelVersion).toBe(
      `anthropic:claude-haiku-4-5-20251001:${FIELD_CAPTURE_PROMPT_VERSION}`,
    );
  });

  it("throws rather than guessing when the response has no matching tool_use block", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ content: [{ type: "text", text: "no." }] })),
      );
    await expect(extractor(fetchFn).extract(INPUT)).rejects.toThrow(/no matching tool_use/);
  });

  it("throws rather than guessing when the tool input fails schema validation", async () => {
    const fetchFn = toolUseResponse({ facts: [{ type: "time_entry" }] });
    await expect(extractor(fetchFn).extract(INPUT)).rejects.toThrow(/schema validation/);
  });

  it.each([
    [429, "rejected", true],
    [500, "ambiguous", false],
  ])("classifies HTTP %i as %s (retryable=%s)", async (status, kind, retryable) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ error: "x" }), { status }));
    const err = await extractor(fetchFn)
      .extract(INPUT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err).toMatchObject({ kind, retryable });
  });

  it("treats a timeout as ambiguous rather than assuming nothing happened", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(extractor(fetchFn).extract(INPUT)).rejects.toMatchObject({ kind: "ambiguous" });
  });
});

describe("anthropicStructuredExtractorFromEnv", () => {
  it("reads the API key from the environment only", () => {
    const built = anthropicStructuredExtractorFromEnv({ ANTHROPIC_API_KEY: "sk-ant-env-key" });
    expect(built).toBeInstanceOf(AnthropicStructuredExtractor);
    expect(built.modelVersion).toBe(`anthropic:claude-sonnet-5:${FIELD_CAPTURE_PROMPT_VERSION}`);
  });

  it("honors ANTHROPIC_MODEL from the environment", () => {
    const built = anthropicStructuredExtractorFromEnv({
      ANTHROPIC_API_KEY: "sk-ant-env-key",
      ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
    });
    expect(built.modelVersion).toBe(
      `anthropic:claude-haiku-4-5-20251001:${FIELD_CAPTURE_PROMPT_VERSION}`,
    );
  });

  it("throws without guessing a key when ANTHROPIC_API_KEY is missing", () => {
    expect(() => anthropicStructuredExtractorFromEnv({})).toThrow(ProviderConfigError);
  });
});
