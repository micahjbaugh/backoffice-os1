import type { VersionedPrompt } from "./prompt";
import type { ToolContract } from "./tool-contract";

/**
 * An agent is a specialized interface to a bounded set of deterministic tools (MASTER_SPEC.md
 * §7): it converses using `prompt` and may request any tool in `tools` by name, but the tools
 * themselves are validated and executed server-side, never by the agent or its prompt.
 */
export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly prompt: VersionedPrompt;
  readonly tools: Readonly<Record<string, ToolContract>>;
}
