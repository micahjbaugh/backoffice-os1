import type { z } from "zod";

/**
 * A named domain tool an agent may request (ARCHITECTURE.md §3, MASTER_SPEC.md §7-8): the agent
 * never calls a provider or mutates a record directly, only requests one of these by name and
 * schema-validated input. The server (packages/core) enforces tenant, authorization, policy and
 * idempotency before executing anything — this contract carries no authorization logic itself.
 */
export type ToolRiskClass = "green" | "yellow" | "red";

export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly riskClass: ToolRiskClass;
  readonly inputSchema: z.ZodType;
}
