// M2-T23: an inbound SMS from a caller who isn't a known employee gets the organization's
// owner-approved acknowledgement template, exactly once per inbound message even on redelivery.
// Known employees are left alone (M3 routes them to field capture). No active template means an
// ops case, never a guessed reply (CLAUDE.md rule 14).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMS_ACK_TEMPLATE_RULE_ACTION } from "@backoffice/domain";
import { processWebhookEvents } from "../src";
import {
  BUSINESS_NUMBER,
  count,
  createWorld,
  CUSTOMER_NUMBER,
  deliver,
  ORG_B_NUMBER,
  setupRoutes,
  twilio,
  twilioInboundSms,
  twilioRequest,
  type World,
} from "./helpers";

const ACK_BODY = "Thanks for texting! We got your message and will get back to you shortly.";

let w: World;

beforeAll(async () => {
  w = await createWorld();
  await setupRoutes(w);
  await w.pg.query(
    `insert into public.business_rules (organization_id, action, rule_key, definition)
     values ($1, $2, 'default', $3)`,
    [w.orgA.id, SMS_ACK_TEMPLATE_RULE_ACTION, JSON.stringify({ body: ACK_BODY })],
  );
});
afterAll(async () => {
  await w.close();
});

const acksTo = (organizationId: string, toNumber: string) =>
  w.pg.query<{ id: string; request: { body: string; fromNumber: string; toNumber: string } }>(
    `select id, request from public.outbound_operations
      where organization_id = $1 and operation_type = 'sms.send' and request->>'toNumber' = $2`,
    [organizationId, toNumber],
  );

const inbound = (sid: string, overrides: Record<string, string> = {}) =>
  deliver(
    w,
    twilio,
    twilioRequest(
      twilioInboundSms({ MessageSid: sid, SmsSid: sid, SmsMessageSid: sid, ...overrides }),
    ),
  );

describe("SMS acknowledgement path", () => {
  it("acknowledges an unknown caller with the owner-approved template and audits it", async () => {
    const sid = "SM" + "1".repeat(32);
    const unknown = "+15125550188";
    await inbound(sid, { From: unknown });
    await processWebhookEvents(w.db);

    const { rows } = await acksTo(w.orgA.id, unknown);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.request).toMatchObject({
      body: ACK_BODY,
      fromNumber: BUSINESS_NUMBER,
      toNumber: unknown,
    });
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'sms.send_requested' and entity_id = $1`,
        [rows[0]?.id],
      ),
    ).toBe(1);
  });

  it("acknowledges a known customer too (only employees are routed elsewhere)", async () => {
    const sid = "SM" + "2".repeat(32);
    await inbound(sid, { From: CUSTOMER_NUMBER });
    await processWebhookEvents(w.db);
    expect((await acksTo(w.orgA.id, CUSTOMER_NUMBER)).rows).toHaveLength(1);
  });

  it("sends exactly one acknowledgement even when the inbound event is redelivered", async () => {
    const sid = "SM" + "3".repeat(32);
    const caller = "+15125550177";
    await inbound(sid, { From: caller });
    await processWebhookEvents(w.db);
    // Simulate the event being reprocessed (crash-recovery retry), not just a provider re-POST.
    await w.pg.query(
      `update public.webhook_receipts set status = 'received' where provider = 'twilio' and provider_event_id = $1`,
      [`${sid}:inbound`],
    );
    await processWebhookEvents(w.db);
    expect((await acksTo(w.orgA.id, caller)).rows).toHaveLength(1);
  });

  it("does not acknowledge a known employee (M3 routes them to field capture instead)", async () => {
    const employeeNumber = "+15125550166";
    await w.pg.query(
      `insert into public.employees (organization_id, display_name, phone) values ($1, 'Jake Tyler', $2)`,
      [w.orgA.id, employeeNumber],
    );
    const sid = "SM" + "4".repeat(32);
    await inbound(sid, { From: employeeNumber });
    await processWebhookEvents(w.db);
    expect((await acksTo(w.orgA.id, employeeNumber)).rows).toHaveLength(0);
  });

  it("opens an ops case instead of guessing a reply when no owner-approved template is active", async () => {
    const sid = "SM" + "5".repeat(32);
    const caller = "+15125550155";
    await inbound(sid, { From: caller, To: ORG_B_NUMBER });
    await processWebhookEvents(w.db);

    expect((await acksTo(w.orgB.id, caller)).rows).toHaveLength(0);
    expect(
      await count(
        w.pg,
        `select 1 from public.ops_cases where organization_id = $1 and reason_code = 'missing_data'`,
        [w.orgB.id],
      ),
    ).toBe(1);
  });
});
