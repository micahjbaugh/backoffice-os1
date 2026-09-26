// M2-T14: call-ended disposition recording, idempotent per (organization_id, providerEventId).
// A replayed call-ended webhook must not duplicate the disposition write, event, or audit entry.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import { recordCall, recordCallDisposition } from "../src";
import { count, inOrg, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const receptionist: Actor = { type: "agent", name: "receptionist-test" };
const voiceWebhook: Actor = { type: "integration", name: "voice-webhook-test" };

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

async function openVoiceCall(orgId: string) {
  const { communication } = await inOrg(w.db, receptionist, orgId, (ctx) =>
    recordCall(ctx, {
      direction: "inbound",
      provider: "vapi",
      providerConversationId: `conv-${randomUUID()}`,
      providerCallId: `provider-call-${randomUUID()}`,
    }),
  );
  return communication;
}

const recordedEvents = (id: string) =>
  count(
    w.pg,
    `select 1 from public.business_events where type = 'communication.disposition_recorded' and entity_id = $1`,
    [id],
  );
const recordedAudits = (id: string) =>
  count(
    w.pg,
    `select 1 from public.audit_log where action = 'communication.disposition_recorded' and entity_id = $1`,
    [id],
  );

describe("recordCallDisposition", () => {
  it("records the disposition, completes the communication, and writes one event and audit entry", async () => {
    const communication = await openVoiceCall(w.orgA.id);
    const providerEventId = `evt-${randomUUID()}`;

    const result = await inOrg(w.db, voiceWebhook, w.orgA.id, (ctx) =>
      recordCallDisposition(ctx, {
        communicationId: communication.id,
        disposition: "qualified_lead",
        providerEventId,
        durationSeconds: 184,
      }),
    );

    expect(result.created).toBe(true);
    expect(result.call.disposition).toBe("qualified_lead");
    expect(result.call.durationSeconds).toBe(184);
    expect(result.communication.status).toBe("completed");
    expect(await recordedEvents(communication.id)).toBe(1);
    expect(await recordedAudits(communication.id)).toBe(1);
  });

  it("is idempotent per (organization_id, providerEventId): a replayed webhook changes nothing", async () => {
    const communication = await openVoiceCall(w.orgA.id);
    const providerEventId = `evt-${randomUUID()}`;

    const first = await inOrg(w.db, voiceWebhook, w.orgA.id, (ctx) =>
      recordCallDisposition(ctx, {
        communicationId: communication.id,
        disposition: "voicemail",
        providerEventId,
        durationSeconds: 12,
      }),
    );
    const second = await inOrg(w.db, voiceWebhook, w.orgA.id, (ctx) =>
      recordCallDisposition(ctx, {
        communicationId: communication.id,
        disposition: "voicemail",
        providerEventId,
        durationSeconds: 12,
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.call.disposition).toBe("voicemail");
    expect(await recordedEvents(communication.id)).toBe(1);
    expect(await recordedAudits(communication.id)).toBe(1);
  });

  it("rejects a communication belonging to a different organization", async () => {
    const communication = await openVoiceCall(w.orgB.id);

    await expect(
      inOrg(w.db, voiceWebhook, w.orgA.id, (ctx) =>
        recordCallDisposition(ctx, {
          communicationId: communication.id,
          disposition: "no_answer",
          providerEventId: `evt-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without communication.write, e.g. a field employee", async () => {
    const communication = await openVoiceCall(w.orgA.id);

    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        recordCallDisposition(ctx, {
          communicationId: communication.id,
          disposition: "resolved",
          providerEventId: `evt-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
