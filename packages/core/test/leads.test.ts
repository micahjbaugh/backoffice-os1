// M2-T10: agent-callable createLead domain tool. Idempotent per (organization_id, idempotency_key).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import { createLead, getLead, recordCall } from "../src";
import { count, inOrg, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const receptionist: Actor = { type: "agent", name: "receptionist-test" };

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

const recordedEvents = (id: string) =>
  count(w.pg, `select 1 from public.business_events where type = 'lead.created' and entity_id = $1`, [id]);
const recordedAudits = (id: string) =>
  count(w.pg, `select 1 from public.audit_log where action = 'lead.created' and entity_id = $1`, [id]);
const leadRows = (organizationId: string, idempotencyKey: string) =>
  count(w.pg, `select 1 from public.leads where organization_id = $1 and idempotency_key = $2`, [
    organizationId,
    idempotencyKey,
  ]);

describe("createLead", () => {
  it("persists a draft lead with an event and audit record", async () => {
    const idempotencyKey = `lead-${randomUUID()}`;
    const { lead, created } = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      createLead(ctx, {
        source: "voice",
        firstName: "Jane",
        phone: "555-0123",
        description: "Interested in a quote",
        idempotencyKey,
      }),
    );
    expect(created).toBe(true);
    expect(lead.status).toBe("new");
    expect(lead.source).toBe("voice");
    expect(lead.firstName).toBe("Jane");

    expect(await recordedEvents(lead.id)).toBe(1);
    expect(await recordedAudits(lead.id)).toBe(1);
  });

  it("is idempotent per (organization_id, idempotency_key): a duplicate call creates one lead", async () => {
    const idempotencyKey = `lead-${randomUUID()}`;
    const first = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      createLead(ctx, { source: "voice", firstName: "Sam", idempotencyKey }),
    );
    expect(first.created).toBe(true);

    const second = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      createLead(ctx, { source: "voice", firstName: "Sam", idempotencyKey }),
    );
    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);

    expect(await leadRows(w.orgA.id, idempotencyKey)).toBe(1);
    expect(await recordedEvents(first.lead.id)).toBe(1);
  });

  it("links a lead to its originating communication within the same organization", async () => {
    const { communication } = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      recordCall(ctx, { direction: "inbound", provider: "vapi", providerConversationId: `conv-${randomUUID()}` }),
    );
    const { lead } = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      createLead(ctx, {
        source: "voice",
        originatingCommunicationId: communication.id,
        idempotencyKey: `lead-${randomUUID()}`,
      }),
    );
    expect(lead.originatingCommunicationId).toBe(communication.id);
  });

  it("rejects a customer reference to an entity outside the organization", async () => {
    await expect(
      inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
        createLead(ctx, {
          source: "voice",
          customerId: w.orgB.customer.id,
          idempotencyKey: `lead-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an originating communication belonging to a different organization", async () => {
    const { communication } = await inOrg(w.db, receptionist, w.orgB.id, (ctx) =>
      recordCall(ctx, { direction: "inbound", provider: "vapi", providerConversationId: `conv-${randomUUID()}` }),
    );
    await expect(
      inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
        createLead(ctx, {
          source: "voice",
          originatingCommunicationId: communication.id,
          idempotencyKey: `lead-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without lead.write, e.g. a field employee", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createLead(ctx, { source: "manual", idempotencyKey: `lead-${randomUUID()}` }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("getLead", () => {
  it("never returns a lead belonging to a different organization", async () => {
    const { lead } = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      createLead(ctx, { source: "voice", idempotencyKey: `lead-${randomUUID()}` }),
    );

    const asOwnerA = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) => getLead(ctx, lead.id));
    expect(asOwnerA?.id).toBe(lead.id);

    const asOwnerB = await inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) => getLead(ctx, lead.id));
    expect(asOwnerB).toBeNull();
  });
});
