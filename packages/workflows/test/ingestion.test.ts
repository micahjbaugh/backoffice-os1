// Findings 3–5: webhook -> durable acceptance -> processing -> Business Brain records, with duplicate,
// out-of-order, concurrent, crashed-worker and unroutable deliveries. Real Twilio/Vapi adapters and
// realistic payloads; a real Postgres (PGlite) with every migration.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requeueUnroutableWebhookEvents, runAs, claimWebhookEvents } from "@backoffice/core";
import { processWebhookEvents, WEBHOOK_PROCESSOR, type WebhookHandler } from "../src";
import {
  BUSINESS_NUMBER,
  count,
  createWorld,
  deliver,
  eventStatus,
  makeEverythingDue,
  MESSAGE_SID,
  ORG_B_NUMBER,
  setupRoutes,
  T0,
  twilio,
  twilioInboundSms,
  twilioRequest,
  vapi,
  VAPI_CALL_ID,
  vapiAssistantRequest,
  vapiEndOfCallReport,
  vapiRequest,
  vapiStatusUpdate,
  VAPI_PHONE_NUMBER_ID,
  type World,
} from "./helpers";

let w: World;
let customerId: string;

beforeAll(async () => {
  w = await createWorld();
  ({ customerId } = await setupRoutes(w));
});
afterAll(async () => {
  await w.close();
});

const communications = (provider: string, conversationId: string) =>
  w.pg.query<{
    id: string;
    organization_id: string;
    status: string;
    direction: string;
    channel: string;
  }>(
    `select id, organization_id, status, direction, channel from public.communications where provider = $1 and provider_conversation_id = $2`,
    [provider, conversationId],
  );

describe("inbound SMS end to end", () => {
  it("accepts durably, resolves the tenant from the route, and records message + matched caller", async () => {
    const accepted = await deliver(
      w,
      twilio,
      twilioRequest(twilioInboundSms(), { idempotencyToken: "tok-a" }),
    );
    expect(accepted).toMatchObject({
      duplicate: false,
      event: { status: "received", organizationId: w.orgA.id, eventType: "sms.inbound" },
    });

    await processWebhookEvents(w.db);
    const { rows } = await communications("twilio", MESSAGE_SID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: w.orgA.id,
      channel: "sms",
      direction: "inbound",
      status: "completed",
    });
    const msg = await w.pg.query<{ body: string }>(
      `select body from public.messages where communication_id = $1`,
      [rows[0]?.id],
    );
    expect(msg.rows[0]?.body).toBe("Me Jake Tyler 7-5:30 Wilson. Hoe 8 hrs");
    const who = await w.pg.query<{ role: string; customer_id: string }>(
      `select role, customer_id from public.communication_participants where communication_id = $1`,
      [rows[0]?.id],
    );
    expect(who.rows[0]).toMatchObject({ role: "customer", customer_id: customerId });
    expect((await eventStatus(w, "twilio", `${MESSAGE_SID}:inbound`))?.status).toBe("processed");
  });

  it("provider retries (same idempotency token) are acknowledged but never processed twice", async () => {
    const retry = await deliver(
      w,
      twilio,
      twilioRequest(twilioInboundSms(), { idempotencyToken: "tok-a" }),
    );
    expect(retry.duplicate).toBe(true);
    await processWebhookEvents(w.db);
    expect((await communications("twilio", MESSAGE_SID)).rows).toHaveLength(1);
    expect((await eventStatus(w, "twilio", `${MESSAGE_SID}:inbound`))?.delivery_count).toBe(2);
  });

  it("concurrent deliveries of one new event store exactly one row", async () => {
    const sid = "SM" + "c".repeat(32);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        deliver(
          w,
          twilio,
          twilioRequest(twilioInboundSms({ MessageSid: sid, SmsSid: sid, SmsMessageSid: sid })),
        ),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect((await eventStatus(w, "twilio", `${sid}:inbound`))?.delivery_count).toBe(3);
    await processWebhookEvents(w.db);
    expect((await communications("twilio", sid)).rows).toHaveLength(1);
  });

  it("routes to the organization that owns the number, never to another tenant", async () => {
    const sid = "SM" + "b".repeat(32);
    await deliver(
      w,
      twilio,
      twilioRequest(
        twilioInboundSms({ MessageSid: sid, SmsSid: sid, SmsMessageSid: sid, To: ORG_B_NUMBER }),
      ),
    );
    await processWebhookEvents(w.db);
    const { rows } = await communications("twilio", sid);
    expect(rows.map((r) => r.organization_id)).toEqual([w.orgB.id]);
    // The org B record has no participant matched to org A's customer.
    const who = await w.pg.query(
      `select customer_id from public.communication_participants where communication_id = $1 and customer_id is not null`,
      [rows[0]?.id],
    );
    expect(who.rows).toHaveLength(0);
  });

  it("an event for an unknown number is stored as unroutable, then processed once a route exists", async () => {
    const sid = "SM" + "d".repeat(32);
    const unknownNumber = "+15125550777";
    const accepted = await deliver(
      w,
      twilio,
      twilioRequest(
        twilioInboundSms({ MessageSid: sid, SmsSid: sid, SmsMessageSid: sid, To: unknownNumber }),
      ),
    );
    expect(accepted.event).toMatchObject({ status: "unroutable", organizationId: null });
    await processWebhookEvents(w.db);
    expect((await communications("twilio", sid)).rows).toHaveLength(0);

    await w.pg.query(
      `insert into public.provider_routes (organization_id, provider, channel, address) values ($1, 'twilio', 'sms', $2)`,
      [w.orgA.id, unknownNumber],
    );
    const requeued = await runAs(w.db, WEBHOOK_PROCESSOR, (tx) =>
      requeueUnroutableWebhookEvents(tx, "twilio", unknownNumber),
    );
    expect(requeued).toBe(1);
    await processWebhookEvents(w.db);
    expect((await communications("twilio", sid)).rows.map((r) => r.organization_id)).toEqual([
      w.orgA.id,
    ]);
  });
});

describe("voice lifecycle: out of order and replayed", () => {
  it("an end-of-call report arriving before earlier status updates is not undone by them", async () => {
    await deliver(w, vapi, vapiRequest(vapiEndOfCallReport()));
    await deliver(w, vapi, vapiRequest(vapiStatusUpdate("in-progress", T0 + 20_000)));
    await deliver(w, vapi, vapiRequest(vapiStatusUpdate("ringing", T0)));
    await processWebhookEvents(w.db);

    const { rows } = await communications("vapi", VAPI_CALL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: w.orgA.id,
      channel: "voice",
      status: "completed",
    });
    const call = await w.pg.query<{ disposition: string; duration_seconds: number }>(
      `select disposition, duration_seconds from public.calls where communication_id = $1`,
      [rows[0]?.id],
    );
    expect(call.rows[0]).toMatchObject({
      disposition: "customer-ended-call",
      duration_seconds: 300,
    });
  });

  it("replaying the end-of-call report records the disposition once", async () => {
    const replay = await deliver(w, vapi, vapiRequest(vapiEndOfCallReport()));
    expect(replay.duplicate).toBe(true);
    // Even if the stored event were processed again (at-least-once), the disposition is keyed on it.
    await w.pg.query(
      `update public.webhook_receipts set status = 'received' where provider = 'vapi' and provider_event_id like '%end-of-call-report%'`,
    );
    await processWebhookEvents(w.db);
    const { rows } = await communications("vapi", VAPI_CALL_ID);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'communication.disposition_recorded' and entity_id = $1`,
        [rows[0]?.id],
      ),
    ).toBe(1);
  });

  it.each(["assistant-request", "tool-calls", "transfer-destination-request"])(
    "%s is durably recorded and settles as processed (answered synchronously by the webhook route, not this background loop)",
    async (type) => {
      const accepted = await deliver(
        w,
        vapi,
        vapiRequest(
          type === "assistant-request"
            ? vapiAssistantRequest()
            : {
                type,
                timestamp: T0,
                call: { id: VAPI_CALL_ID },
                phoneNumber: { id: VAPI_PHONE_NUMBER_ID, number: BUSINESS_NUMBER },
                ...(type === "tool-calls"
                  ? {
                      toolCallList: [
                        { id: "tc-1", function: { name: "lookup_business_info", arguments: {} } },
                      ],
                    }
                  : {}),
              },
        ),
      );
      await processWebhookEvents(w.db);
      const row = await w.pg.query<{ status: string; last_error: string | null }>(
        `select status, last_error from public.webhook_receipts where id = $1`,
        [accepted.event.id],
      );
      expect(row.rows[0]).toMatchObject({ status: "processed", last_error: null });
    },
  );
});

describe("processing failures and crashed workers", () => {
  it("a worker that crashes after claiming leaves the event to be re-claimed after its lock, processed once", async () => {
    const sid = "SM" + "e".repeat(32);
    await deliver(
      w,
      twilio,
      twilioRequest(twilioInboundSms({ MessageSid: sid, SmsSid: sid, SmsMessageSid: sid })),
    );
    const claimed = await claimWebhookEvents(w.db, { limit: 50 }); // ...and then the worker "dies"
    expect(claimed.map((e) => e.eventKey)).toContain(`${sid}:inbound`);
    expect((await processWebhookEvents(w.db)).claimed).toBe(0); // still locked
    await w.pg.query(
      `update public.webhook_receipts set locked_until = now() - interval '1 second' where status = 'processing'`,
    );
    await processWebhookEvents(w.db);
    expect((await communications("twilio", sid)).rows).toHaveLength(1);
    expect((await eventStatus(w, "twilio", `${sid}:inbound`))?.status).toBe("processed");
  });

  it("failures retry with backoff, then dead-letter to a person without being dropped", async () => {
    const sid = "SM" + "f".repeat(32);
    const accepted = await deliver(
      w,
      twilio,
      twilioRequest(twilioInboundSms({ MessageSid: sid, SmsSid: sid, SmsMessageSid: sid })),
    );
    await w.pg.query(`update public.webhook_receipts set max_attempts = 2 where id = $1`, [
      accepted.event.id,
    ]);
    const broken: Record<string, WebhookHandler> = {
      "sms.inbound": async () => {
        throw new Error("downstream exploded");
      },
    };

    expect((await processWebhookEvents(w.db, { handlers: broken })).retrying).toBe(1);
    expect((await eventStatus(w, "twilio", `${sid}:inbound`))?.status).toBe("failed");
    expect((await processWebhookEvents(w.db, { handlers: broken })).claimed).toBe(0); // backoff not elapsed
    await makeEverythingDue(w);
    expect((await processWebhookEvents(w.db, { handlers: broken })).dead).toBe(1);

    const dead = await w.pg.query<{ status: string; last_error: string }>(
      `select status, last_error from public.webhook_receipts where id = $1`,
      [accepted.event.id],
    );
    expect(dead.rows[0]).toMatchObject({ status: "dead", last_error: "downstream exploded" });
    expect(
      await count(
        w.pg,
        `select 1 from public.ops_cases where organization_id = $1 and evidence->>'webhook_event_id' = $2`,
        [w.orgA.id, accepted.event.id],
      ),
    ).toBe(1);
    // Nothing was half-written by the failing handler.
    expect((await communications("twilio", sid)).rows).toHaveLength(0);
  });
});

describe("stored payloads are enough to recover", () => {
  it("keeps validated fields (not the raw request) with routing info for reprocessing", async () => {
    const row = await w.pg.query<{ payload: Record<string, unknown> }>(
      `select payload from public.webhook_receipts where provider = 'twilio' and provider_event_id = $1`,
      [`${MESSAGE_SID}:inbound`],
    );
    expect(row.rows[0]?.payload).toMatchObject({
      messageSid: MESSAGE_SID,
      to: BUSINESS_NUMBER,
      routingAddress: BUSINESS_NUMBER,
      channel: "sms",
    });
    expect(row.rows[0]?.payload).not.toHaveProperty("AccountSid");
  });
});
