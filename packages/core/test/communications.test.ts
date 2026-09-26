// M2-T09: call and message recording services. Both are idempotent per
// (provider, provider_conversation_id).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import { getCommunication, recordCall, recordMessage } from "../src";
import { count, inOrg, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const webhook: Actor = { type: "integration", name: "voice-webhook-test" };

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

const recordedEvents = (id: string) =>
  count(w.pg, `select 1 from public.business_events where type = 'communication.recorded' and entity_id = $1`, [id]);
const recordedAudits = (id: string) =>
  count(w.pg, `select 1 from public.audit_log where action = 'communication.recorded' and entity_id = $1`, [id]);
const callRows = (communicationId: string) =>
  count(w.pg, `select 1 from public.calls where communication_id = $1`, [communicationId]);
const communicationRows = (provider: string, conversationId: string) =>
  count(w.pg, `select 1 from public.communications where provider = $1 and provider_conversation_id = $2`, [
    provider,
    conversationId,
  ]);

describe("recordCall", () => {
  it("persists the communication, call and participants with an event and audit record", async () => {
    const conversationId = `conv-${randomUUID()}`;
    const { communication, call, participants, created } = await inOrg(w.db, webhook, w.orgA.id, (ctx) =>
      recordCall(ctx, {
        direction: "inbound",
        provider: "vapi",
        providerConversationId: conversationId,
        fromNumber: w.orgA.customer.phone ?? "555-0100",
        toNumber: "+15005550006",
        participants: [{ role: "customer", customerId: w.orgA.customer.id, displayName: "Test Customer" }],
      }),
    );
    expect(created).toBe(true);
    expect(communication.channel).toBe("voice");
    expect(communication.status).toBe("in_progress");
    expect(call.fromNumber).toBe(w.orgA.customer.phone ?? "555-0100");
    expect(participants).toHaveLength(1);
    expect(participants[0]?.customerId).toBe(w.orgA.customer.id);

    expect(await recordedEvents(communication.id)).toBe(1);
    expect(await recordedAudits(communication.id)).toBe(1);
  });

  it("is idempotent per (provider, provider_conversation_id): a later lifecycle event updates, not duplicates", async () => {
    const conversationId = `conv-${randomUUID()}`;
    const first = await inOrg(w.db, webhook, w.orgA.id, (ctx) =>
      recordCall(ctx, {
        direction: "inbound",
        provider: "vapi",
        providerConversationId: conversationId,
        status: "in_progress",
      }),
    );
    expect(first.created).toBe(true);

    const second = await inOrg(w.db, webhook, w.orgA.id, (ctx) =>
      recordCall(ctx, {
        direction: "inbound",
        provider: "vapi",
        providerConversationId: conversationId,
        status: "completed",
        durationSeconds: 90,
        disposition: "qualified_lead",
      }),
    );
    expect(second.created).toBe(false);
    expect(second.communication.id).toBe(first.communication.id);
    expect(second.communication.status).toBe("completed");
    expect(second.call.durationSeconds).toBe(90);
    expect(second.call.disposition).toBe("qualified_lead");

    expect(await communicationRows("vapi", conversationId)).toBe(1);
    expect(await callRows(first.communication.id)).toBe(1);
    expect(await recordedEvents(first.communication.id)).toBe(1);
  });

  it("rejects a participant reference to an entity outside the organization", async () => {
    await expect(
      inOrg(w.db, webhook, w.orgA.id, (ctx) =>
        recordCall(ctx, {
          direction: "inbound",
          provider: "vapi",
          providerConversationId: `conv-${randomUUID()}`,
          participants: [{ role: "customer", customerId: w.orgB.customer.id }],
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without communication.write, e.g. a field employee", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        recordCall(ctx, {
          direction: "inbound",
          provider: "vapi",
          providerConversationId: `conv-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

const messageRows = (communicationId: string) =>
  count(w.pg, `select 1 from public.messages where communication_id = $1`, [communicationId]);

describe("recordMessage", () => {
  it("persists the communication, message and participants with an event and audit record", async () => {
    const conversationId = `conv-${randomUUID()}`;
    const { communication, message, participants, created } = await inOrg(w.db, webhook, w.orgA.id, (ctx) =>
      recordMessage(ctx, {
        direction: "inbound",
        provider: "twilio",
        providerConversationId: conversationId,
        channel: "sms",
        fromAddress: w.orgA.customer.phone ?? "555-0100",
        toAddress: "+15005550006",
        body: "hello",
        mediaUrls: ["https://example.test/a.jpg"],
        participants: [{ role: "customer", customerId: w.orgA.customer.id, displayName: "Test Customer" }],
      }),
    );
    expect(created).toBe(true);
    expect(communication.channel).toBe("sms");
    expect(message.body).toBe("hello");
    expect(message.mediaUrls).toEqual(["https://example.test/a.jpg"]);
    expect(participants).toHaveLength(1);
    expect(participants[0]?.customerId).toBe(w.orgA.customer.id);

    expect(await recordedEvents(communication.id)).toBe(1);
    expect(await recordedAudits(communication.id)).toBe(1);
  });

  it("is idempotent per (provider, provider_conversation_id): a later lifecycle event updates, not duplicates", async () => {
    const conversationId = `conv-${randomUUID()}`;
    const first = await inOrg(w.db, webhook, w.orgA.id, (ctx) =>
      recordMessage(ctx, {
        direction: "outbound",
        provider: "twilio",
        providerConversationId: conversationId,
        channel: "sms",
        status: "in_progress",
        body: "first",
      }),
    );
    expect(first.created).toBe(true);

    const second = await inOrg(w.db, webhook, w.orgA.id, (ctx) =>
      recordMessage(ctx, {
        direction: "outbound",
        provider: "twilio",
        providerConversationId: conversationId,
        channel: "sms",
        status: "completed",
        body: "delivered",
      }),
    );
    expect(second.created).toBe(false);
    expect(second.communication.id).toBe(first.communication.id);
    expect(second.communication.status).toBe("completed");
    expect(second.message.body).toBe("delivered");

    expect(await communicationRows("twilio", conversationId)).toBe(1);
    expect(await messageRows(first.communication.id)).toBe(1);
    expect(await recordedEvents(first.communication.id)).toBe(1);
  });

  it("rejects a participant reference to an entity outside the organization", async () => {
    await expect(
      inOrg(w.db, webhook, w.orgA.id, (ctx) =>
        recordMessage(ctx, {
          direction: "inbound",
          provider: "twilio",
          providerConversationId: `conv-${randomUUID()}`,
          channel: "sms",
          participants: [{ role: "customer", customerId: w.orgB.customer.id }],
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without communication.write, e.g. a field employee", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        recordMessage(ctx, {
          direction: "inbound",
          provider: "twilio",
          providerConversationId: `conv-${randomUUID()}`,
          channel: "sms",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("getCommunication", () => {
  it("never returns a communication belonging to a different organization", async () => {
    const { communication } = await inOrg(w.db, webhook, w.orgA.id, (ctx) =>
      recordCall(ctx, {
        direction: "outbound",
        provider: "vapi",
        providerConversationId: `conv-${randomUUID()}`,
      }),
    );

    const asOwnerA = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      getCommunication(ctx, communication.id),
    );
    expect(asOwnerA?.id).toBe(communication.id);

    const asOwnerB = await inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) =>
      getCommunication(ctx, communication.id),
    );
    expect(asOwnerB).toBeNull();
  });
});
