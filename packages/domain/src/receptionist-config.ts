// Per-tenant receptionist settings (M2-T19), stored as a `business_rules` row (ARCHITECTURE.md §6:
// business rules are versioned data, not code). No active, valid rule for an organization means the
// receptionist runtime has nothing safe to tell a caller, so it falls back instead of guessing
// business hours (CLAUDE.md rule 14).

import { z } from "zod";

export const RECEPTIONIST_CONFIG_RULE_ACTION = "receptionist.config";

export const receptionistConfigDefinitionSchema = z
  .object({
    business_hours: z.string().trim().min(1).max(200),
  })
  .strict();

export type ReceptionistConfigDefinition = z.infer<typeof receptionistConfigDefinitionSchema>;
