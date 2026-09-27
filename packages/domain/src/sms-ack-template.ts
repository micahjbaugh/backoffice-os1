// M2-T23: the acknowledgement an unknown/customer SMS sender gets, stored as a `business_rules` row
// (same versioned-data pattern as receptionist-config.ts). Only the owner can write business rules
// (`rule.write`, permissions.ts), so an active rule of this action is by construction owner-approved;
// no active rule means the runtime has no safe text to send and must not guess one (CLAUDE.md rule 14).

import { z } from "zod";

export const SMS_ACK_TEMPLATE_RULE_ACTION = "sms.acknowledgement_template";

/** One template per organization; versions replace each other under this fixed key. */
export const SMS_ACK_TEMPLATE_RULE_KEY = "default";

export const smsAckTemplateDefinitionSchema = z
  .object({
    body: z.string().trim().min(1).max(320),
  })
  .strict();

export type SmsAckTemplateDefinition = z.infer<typeof smsAckTemplateDefinitionSchema>;
