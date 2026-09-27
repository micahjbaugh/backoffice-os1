// Per-tenant receptionist settings (M2-T19), stored as a `business_rules` row (ARCHITECTURE.md §6:
// business rules are versioned data, not code). No active, valid rule for an organization means the
// receptionist runtime has nothing safe to tell a caller, so it falls back instead of guessing
// business hours (CLAUDE.md rule 14).

import { z } from "zod";

export const RECEPTIONIST_CONFIG_RULE_ACTION = "receptionist.config";

export const receptionistConfigDefinitionSchema = z
  .object({
    business_hours: z.string().trim().min(1).max(200),
    services: z.string().trim().min(1).max(1000).optional(),
    service_area: z.string().trim().min(1).max(500).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    /**
     * The deterministic warm-transfer policy (M2-T21): the one employee a live caller transfer
     * goes to. No employee configured (or one that turns out inactive / phoneless) is out of
     * policy and escalates to an ops case instead of guessing a destination (CLAUDE.md rule 14).
     */
    transfer_employee_id: z.string().uuid().optional(),
  })
  .strict();

export type ReceptionistConfigDefinition = z.infer<typeof receptionistConfigDefinitionSchema>;

/** Topics the receptionist's lookup_business_info tool may ask about (packages/agents tools.ts). */
export const BUSINESS_INFO_TOPICS = ["hours", "services", "service_area", "address"] as const;
export type BusinessInfoTopic = (typeof BUSINESS_INFO_TOPICS)[number];
