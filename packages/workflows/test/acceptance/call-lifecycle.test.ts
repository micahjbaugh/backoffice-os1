// M2 acceptance suite (M2-T26): a realistic inbound call through the real webhook route logic
// (helpers.deliverVoiceEvent mirrors apps/web/src/app/api/webhooks/voice/route.ts), the durable
// event store, the background processor, the receptionist runtime and the outbox worker.
//
// Story: call business number -> agent identifies the company -> qualifies a fake lead -> safely
// looks up permitted business info -> creates a lead and a call summary -> warm transfer -> ends
// with a disposition, every step audited.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECEPTIONIST_CONFIG_RULE_ACTION, type Actor } from "@backoffice/domain";
import { inTenant, runAs, transferCall } from "@backoffice/core";
import { FakeSmsProvider, FakeVoiceProvider, type ProviderRuntime } from "@backoffice/integrations";
import { dispatchOutboundOperations, processWebhookEvents } from "../../src";
import {
  count,
  createWorld,
  CUSTOMER_NUMBER,
  deliverVoiceEvent,
  eventStatus,
  setupRoutes,
  vapiAssistantRequest,
  vapiEndOfCallReport,
  vapiToolCalls,
  vapiTransferDestinationRequest,
  VAPI_CALL_ID,
  type World,
} from "../helpers";

const SECRET = "acceptance-outbox-secret-01";
let w: World;
let employeeId: string;
const owner = (): Actor => ({ type: "user", userId: w.orgA.owner });

function runtime(): ProviderRuntime & { sms: FakeSmsProvider; voice: FakeVoiceProvider } {
  return { mode: "fake", sms: new FakeSmsProvider(SECRET), voice: new FakeVoiceProvider(SECRET) };
}

const communicationByCallId = async () =>
  (
    await w.pg.query<{ id: string; status: string; summary: string | null }>(
      `select id, status, summary from public.communications where provider = 'vapi' and provider_conversation_id = $1`,
      [VAPI_CALL_ID],
    )
  ).rows[0];

beforeAll(async () => {
  w = await createWorld();
  await setupRoutes(w);
  const employee = await w.pg.query<{ id: string }>(
    `insert into public.employees (organization_id, display_name, phone) values ($1, 'On-call Tech', '+15125550188') returning id`,
    [w.orgA.id],
  );
  employeeId = (employee.rows[0] as { id: string }).id;
  await w.pg.query(
    `insert into public.business_rules (organization_id, action, rule_key, definition) values ($1, $2, 'default', $3::jsonb)`,
    [
      w.orgA.id,
      RECEPTIONIST_CONFIG_RULE_ACTION,
      JSON.stringify({
        business_hours: "Mon-Fri 8am-5pm",
        services: "Excavation and driveway grading",
        transfer_employee_id: employeeId,
      }),
    ],
  );
});
afterAll(async () => {
  await w.close();
});

describe("call business number", () => {
  it("the agent identifies the company by name", async () => {
    const { accepted, answer } = await deliverVoiceEvent(w, vapiAssistantRequest());
    expect(accepted.event).toMatchObject({ organizationId: w.orgA.id, status: "received" });
    expect(answer).toMatchObject({
      assistant: {
        firstMessage: expect.stringContaining("Org A"),
        model: { messages: [{ role: "system", content: expect.stringContaining("Org A") }] },
      },
    });
    await processWebhookEvents(w.db);
    expect((await eventStatus(w, "vapi", accepted.event.eventKey))?.status).toBe("processed");
  });
});

let leadId: string;

describe("qualifies a fake lead and looks up permitted business info", () => {
  it("logs a lead, answers a configured topic, and declines an unconfigured one", async () => {
    const toolCalls = [
      { id: "tc-lookup", name: "lookup_business_info", arguments: { topic: "services" } },
      { id: "tc-addr", name: "lookup_business_info", arguments: { topic: "address" } },
      {
        id: "tc-lead",
        name: "create_lead",
        arguments: {
          source: "voice",
          firstName: "Jamie",
          phone: CUSTOMER_NUMBER,
          description: "Wants a quote to grade a 200 ft driveway.",
        },
      },
    ];
    const { answer } = await deliverVoiceEvent(w, vapiToolCalls(toolCalls));
    const results = (answer as { results: { toolCallId: string; result: string }[] }).results;
    expect(results[0]?.result).toContain("Excavation");
    expect(results[1]?.result).toMatch(/don't have that information/i);
    expect(results[2]?.result).toMatch(/logged this as a new lead/i);
    await processWebhookEvents(w.db);

    const lead = await w.pg.query<{ id: string; status: string }>(
      `select id, status from public.leads where organization_id = $1 and phone = $2`,
      [w.orgA.id, CUSTOMER_NUMBER],
    );
    expect(lead.rows).toHaveLength(1);
    expect(lead.rows[0]).toMatchObject({ status: "new" });
    leadId = (lead.rows[0] as { id: string }).id;
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'lead.created' and entity_id = $1 and actor_type = 'agent'`,
        [leadId],
      ),
    ).toBe(1);
  });
});

describe("warm transfer works", () => {
  it("queues a transfer to the on-call employee and the outbox worker completes it", async () => {
    const comm = await communicationByCallId();
    const { operationId } = await runAs(w.db, owner(), (tx) =>
      transferCall(inTenant(tx, w.orgA.id), {
        communicationId: (comm as { id: string }).id,
        toEmployeeId: employeeId,
        reason: "caller_requested_human",
        idempotencyKey: `transfer-${VAPI_CALL_ID}`,
      }),
    );
    const rt = runtime();
    const summary = await dispatchOutboundOperations(w.db, rt);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);
    expect(rt.voice.transfers).toHaveLength(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'communication.transferred' and entity_id = $1`,
        [(comm as { id: string }).id],
      ),
    ).toBe(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.outbound_operations where id = $1 and status = 'succeeded'`,
        [operationId],
      ),
    ).toBe(1);
  });

  it("Vapi's native transfer-destination-request also resolves to the on-call number", async () => {
    const { answer } = await deliverVoiceEvent(w, vapiTransferDestinationRequest());
    expect(answer).toEqual({ destination: { type: "number", number: "+15125550188" } });
  });
});

describe("creates lead and call summary, then a disposition", () => {
  it("records the summary and disposition, and links the outcome to the lead once", async () => {
    await deliverVoiceEvent(w, vapiEndOfCallReport());
    await processWebhookEvents(w.db);

    const comm = await communicationByCallId();
    expect(comm).toMatchObject({ status: "completed", summary: expect.stringContaining("grade") });
    expect(
      await count(
        w.pg,
        `select 1 from public.calls where communication_id = $1 and disposition = 'customer-ended-call'`,
        [(comm as { id: string }).id],
      ),
    ).toBe(1);

    const activity = await w.pg.query<{ body: string | null }>(
      `select body from public.lead_activities where lead_id = $1`,
      [leadId],
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]?.body).toContain("grade");
    const lead = await w.pg.query<{ status: string }>(
      `select status from public.leads where id = $1`,
      [leadId],
    );
    expect(lead.rows[0]).toMatchObject({ status: "contacted" });
  });
});
