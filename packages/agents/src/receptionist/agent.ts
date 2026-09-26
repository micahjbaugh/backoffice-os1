import type { AgentDefinition } from "../agent-definition";
import { RECEPTIONIST_PROMPT } from "./prompt";
import { receptionistTools } from "./tools";

export const receptionistAgent: AgentDefinition = {
  name: "receptionist",
  description:
    "Inbound phone/SMS receptionist: identifies the business, answers permitted FAQs, qualifies leads, and escalates to a human when uncertain (MASTER_SPEC.md §7, M2_READINESS.md).",
  prompt: RECEPTIONIST_PROMPT,
  tools: receptionistTools,
};
