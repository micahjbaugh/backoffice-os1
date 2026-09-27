// Real LLM extractor adapter for field capture (ARCHITECTURE.md §8-9; CLAUDE.md rule 9-10). The
// only place the Anthropic Messages API is called: domain code only ever sees StructuredExtractor.
// The prompt is versioned in source, contains no secrets and makes no authorization decisions
// (CLAUDE.md rule 4) — it only proposes facts; matching, thresholds and approvals happen later in
// the field-capture pipeline (M3-T11+). A response that fails schema validation or never calls the
// extraction tool is a thrown error, not a best-effort guess (CLAUDE.md rule 14).

import {
  fieldCaptureExtractionSchema,
  type ExtractionInput,
  type ExtractionResult,
  type FieldCaptureExtraction,
  type StructuredExtractor,
} from "@backoffice/domain";
import { z } from "zod";
import { errorForResponse, providerFetch } from "../outcomes";
import { ProviderConfigError } from "../runtime-config";

/** Bump whenever SYSTEM_PROMPT or the tool contract changes; carried in modelVersion. */
export const FIELD_CAPTURE_PROMPT_VERSION = "field-capture-v1";

const TOOL_NAME = "record_field_capture_extraction";

const SYSTEM_PROMPT = `You read one short message from a field crew member (an SMS or a call transcript) reporting work performed on a job site, and extract structured facts about it. You do not decide who is allowed to see or act on this data, and you never approve, reject, bill, invoice or pay anything — you only extract candidate facts for a human or a downstream system to review.

Extract zero or more facts of these types: time_entry, equipment_usage, material_usage, job_note, billable_opportunity. For every fact:
- give it a factKey unique within this extraction (e.g. "time-1", "equip-1", "equip-2"),
- fill only the fields you have text to support; never invent a value the message does not support,
- give every populated field a confidence score from 0 (a guess) to 1 (verbatim and unambiguous),
- give at least one evidence span: a short verbatim quote from the message that backs the fact.

If part of the message is ambiguous (an unclear name, a value that could belong to more than one job, a reference you cannot resolve), lower confidence to reflect that rather than guessing, and where useful add an unresolvedQuestion: a plain-language question a human could answer, referencing the related factKey when there is one. If nothing in the message supports a usable fact, return no facts.

Respond only by calling the ${TOOL_NAME} tool with the extraction. Do not reply with plain text.`;

const EXTRACTION_INPUT_SCHEMA = z.toJSONSchema(fieldCaptureExtractionSchema, {
  unrepresentable: "any",
}) as Record<string, unknown>;

export interface AnthropicStructuredExtractorConfig {
  /** Read from the environment by callers (e.g. anthropicStructuredExtractorFromEnv); never hardcoded. */
  apiKey: string;
  model?: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "claude-sonnet-5";
const ANTHROPIC_API_VERSION = "2023-06-01";

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicMessagesResponse {
  content?: ReadonlyArray<{ type: string; name?: string; input?: unknown }>;
}

/** Real Anthropic Messages API adapter. The only place that API is called (CLAUDE.md rule 9). */
export class AnthropicStructuredExtractor implements StructuredExtractor<FieldCaptureExtraction> {
  readonly modelVersion: string;
  private readonly fetchFn: typeof fetch;
  private readonly model: string;

  constructor(private readonly config: AnthropicStructuredExtractorConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model ?? DEFAULT_MODEL;
    this.modelVersion = `anthropic:${this.model}:${FIELD_CAPTURE_PROMPT_VERSION}`;
  }

  private get baseUrl(): string {
    return this.config.apiBaseUrl ?? "https://api.anthropic.com";
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult<FieldCaptureExtraction>> {
    const response = await providerFetch(
      "anthropic",
      this.fetchFn,
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: input.text }],
          tools: [
            {
              name: TOOL_NAME,
              description: "Record the structured extraction for this message.",
              input_schema: EXTRACTION_INPUT_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: TOOL_NAME },
        }),
      },
      this.config.timeoutMs,
    );
    if (!response.ok) throw errorForResponse("anthropic", response.status, await response.text());

    const payload = (await response.json()) as AnthropicMessagesResponse;
    const toolUse = payload.content?.find(
      (block): block is AnthropicToolUseBlock =>
        block.type === "tool_use" && block.name === TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error(`anthropic response for ${TOOL_NAME} had no matching tool_use block`);
    }
    const parsed = fieldCaptureExtractionSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(
        `anthropic extraction failed schema validation: ${parsed.error.issues[0]?.message}`,
      );
    }
    return { data: parsed.data, modelVersion: this.modelVersion };
  }
}

/** Builds the adapter from environment variables only (CLAUDE.md rule 5: no hardcoded secrets). */
export function anthropicStructuredExtractorFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AnthropicStructuredExtractor {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ProviderConfigError("AnthropicStructuredExtractor needs ANTHROPIC_API_KEY");
  }
  return new AnthropicStructuredExtractor({ apiKey, model: env.ANTHROPIC_MODEL });
}
