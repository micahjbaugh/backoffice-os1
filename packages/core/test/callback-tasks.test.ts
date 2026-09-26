// M2-T11: agent-callable createCallbackTask, a thin wrapper over createTask that links the
// task to the call/communication that prompted it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import { createCallbackTask, recordCall } from "../src";
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
  count(w.pg, `select 1 from public.business_events where type = 'task.created' and entity_id = $1`, [id]);
const recordedAgentAudits = (id: string) =>
  count(
    w.pg,
    `select 1 from public.audit_log
      where action = 'task.created' and entity_id = $1 and actor_type = 'agent'`,
    [id],
  );

async function callInOrg(orgId: string) {
  return inOrg(w.db, receptionist, orgId, (ctx) =>
    recordCall(ctx, { direction: "inbound", provider: "vapi", providerConversationId: `conv-${randomUUID()}` }),
  );
}

describe("createCallbackTask", () => {
  it("creates a task linked to the call and audited with the agent actor", async () => {
    const { communication } = await callInOrg(w.orgA.id);
    const task = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      createCallbackTask(ctx, { communicationId: communication.id, title: "Call Jane back" }),
    );

    expect(task.title).toBe("Call Jane back");
    expect(task.entityType).toBe("communication");
    expect(task.entityId).toBe(communication.id);

    expect(await recordedEvents(task.id)).toBe(1);
    expect(await recordedAgentAudits(task.id)).toBe(1);
  });

  it("rejects a communication belonging to a different organization", async () => {
    const { communication } = await callInOrg(w.orgB.id);
    await expect(
      inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
        createCallbackTask(ctx, { communicationId: communication.id, title: "Call back" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without task.create, e.g. a field employee", async () => {
    const { communication } = await callInOrg(w.orgA.id);
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createCallbackTask(ctx, { communicationId: communication.id, title: "Call back" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
