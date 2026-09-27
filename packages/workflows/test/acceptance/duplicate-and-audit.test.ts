// M2 acceptance suite (M2-T26): duplicate, concurrent and out-of-order webhook deliveries through
// the real receptionist tool-calls path never duplicate a lead, and every insert still leaves
// exactly one audit trail entry — the same guarantee call-lifecycle.test.ts exercises for the happy
// path, here under redelivery and races.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECEPTIONIST_CONFIG_RULE_ACTION } from "@backoffice/domain";
import { processWebhookEvents } from "../../src";
import {
  count,
  createWorld,
  CUSTOMER_NUMBER,
  deliverVoiceEvent,
  vapiEndOfCallReport,
  vapiToolCalls,
  setupRoutes,
  VAPI_CALL_ID,
  type World,
} from "../helpers";

let w: World;

beforeAll(async () => {
  w = await createWorld();
  await setupRoutes(w);
  await w.pg.query(
    `insert into public.business_rules (organization_id, action, rule_key, definition) values ($1, $2, 'default', $3::jsonb)`,
    [
      w.orgA.id,
      RECEPTIONIST_CONFIG_RULE_ACTION,
      JSON.stringify({ business_hours: "Mon-Fri 8am-5pm" }),
    ],
  );
});
afterAll(async () => {
  await w.close();
});

const leadCount = () =>
  count(w.pg, `select 1 from public.leads where organization_id = $1 and phone = $2`, [
    w.orgA.id,
    CUSTOMER_NUMBER,
  ]);
const auditCount = (action: string) =>
  count(w.pg, `select 1 from public.audit_log where organization_id = $1 and action = $2`, [
    w.orgA.id,
    action,
  ]);
const createLeadCall = (toolCallId: string) => [
  {
    id: toolCallId,
    name: "create_lead",
    arguments: {
      source: "voice",
      firstName: "Riley",
      phone: CUSTOMER_NUMBER,
      description: "Asking about a fence repair estimate.",
    },
  },
];

describe("duplicate webhook does not duplicate the lead", () => {
  it("re-delivering the identical tool-calls message (provider retry) logs the lead once", async () => {
    const message = vapiToolCalls(createLeadCall(`tc-dup-${randomUUID()}`));

    const first = await deliverVoiceEvent(w, message);
    expect(first.accepted.duplicate).toBe(false);
    const second = await deliverVoiceEvent(w, message);
    expect(second.accepted.duplicate).toBe(true);

    await processWebhookEvents(w.db);
    expect(await leadCount()).toBe(1);
    expect(await auditCount("lead.created")).toBe(1);
    expect((second.answer as { results: { result: string }[] }).results[0]?.result).toMatch(
      /logged this as a new lead/i,
    );
  });
});

describe("concurrent identical webhook deliveries do not duplicate the lead", () => {
  it("three simultaneous deliveries of the same message store one webhook receipt and one lead", async () => {
    const message = vapiToolCalls(createLeadCall(`tc-race-${randomUUID()}`));
    const before = await leadCount();

    const results = await Promise.all([1, 2, 3].map(() => deliverVoiceEvent(w, message)));
    expect(results.filter((r) => !r.accepted.duplicate)).toHaveLength(1);

    await processWebhookEvents(w.db);
    expect(await leadCount()).toBe(before + 1);
  });
});

describe("out-of-order delivery never resurrects a completed call", () => {
  it("a late tool-calls redelivery after the end-of-call report leaves the call completed", async () => {
    const message = vapiToolCalls(createLeadCall(`tc-late-${randomUUID()}`));
    await deliverVoiceEvent(w, message);
    await deliverVoiceEvent(w, vapiEndOfCallReport());
    await processWebhookEvents(w.db);

    const completed = async () =>
      (
        await w.pg.query<{ status: string }>(
          `select status from public.communications where provider = 'vapi' and provider_conversation_id = $1`,
          [VAPI_CALL_ID],
        )
      ).rows[0]?.status;
    expect(await completed()).toBe("completed");

    // The provider redelivers the earlier tool-calls webhook (out of order); it still needs an
    // answer, but must not undo the call's terminal status.
    await deliverVoiceEvent(w, message);
    await processWebhookEvents(w.db);
    expect(await completed()).toBe("completed");
  });
});
