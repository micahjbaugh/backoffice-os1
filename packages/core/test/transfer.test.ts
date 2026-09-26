// M2-T13 (reworked in the foundation repair): warm transfer is recorded as an outbound operation with
// a transfer_requested event + audit; the outbox worker performs it (packages/workflows tests cover
// execution, retries, crashes and reconciliation). Rejects a communication or employee outside the
// caller's organization, an untransferable call, or a destination with no phone on file.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import { createEmployee, recordCall, transferCall } from "../src";
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
    `select 1 from public.business_events where type = 'communication.transfer_requested' and entity_id = $1`,
    [id],
  );

describe("transferCall", () => {
  it("queues a transfer operation with an event and audit, without calling any provider", async () => {
    const communication = await openVoiceCall(w.orgA.id);
    const employee = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createEmployee(ctx, { displayName: "On-call Tech", phone: "+15005550010" }),
    );
    const result = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      transferCall(ctx, {
        communicationId: communication.id,
        toEmployeeId: employee.id,
        reason: "caller_requested_human",
        idempotencyKey: `transfer-${randomUUID()}`,
      }),
    );
    expect(result).toMatchObject({ status: "pending", created: true, toEmployeeId: employee.id });
    const op = await w.pg.query<{
      operation_type: string;
      request: Record<string, unknown>;
      status: string;
    }>(`select operation_type, request, status from public.outbound_operations where id = $1`, [
      result.operationId,
    ]);
    expect(op.rows[0]).toMatchObject({
      operation_type: "call.transfer",
      status: "pending",
      request: { toNumber: "+15005550010", toEmployeeId: employee.id },
    });
    expect(await recordedEvents(communication.id)).toBe(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'communication.transfer_requested' and entity_id = $1`,
        [communication.id],
      ),
    ).toBe(1);
  });

  it("is idempotent per (organization_id, idempotency_key): a retried request queues nothing new", async () => {
    const communication = await openVoiceCall(w.orgA.id);
    const employee = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createEmployee(ctx, { displayName: "Retry Target", phone: "+15005550011" }),
    );
    const input = {
      communicationId: communication.id,
      toEmployeeId: employee.id,
      reason: "caller_requested_human" as const,
      idempotencyKey: `transfer-${randomUUID()}`,
    };
    const first = await inOrg(w.db, receptionist, w.orgA.id, (ctx) => transferCall(ctx, input));
    const second = await inOrg(w.db, receptionist, w.orgA.id, (ctx) => transferCall(ctx, input));
    expect(second).toMatchObject({ operationId: first.operationId, created: false });
    expect(await recordedEvents(communication.id)).toBe(1);
    expect(
      await count(w.pg, `select 1 from public.outbound_operations where entity_id = $1`, [
        communication.id,
      ]),
    ).toBe(1);
  });

  it("rejects a communication with no in-progress voice call", async () => {
    const { communication } = await inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
      recordCall(ctx, {
        direction: "inbound",
        provider: "vapi",
        providerConversationId: `conv-${randomUUID()}`,
        status: "completed",
      }),
    );
    const employee = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createEmployee(ctx, { displayName: "No Call", phone: "+15005550012" }),
    );

    await expect(
      inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
        transferCall(ctx, {
          communicationId: communication.id,
          toEmployeeId: employee.id,
          reason: "provider_failure",
          idempotencyKey: `transfer-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a transfer target employee belonging to a different organization", async () => {
    const communication = await openVoiceCall(w.orgA.id);
    const otherOrgEmployee = await inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) =>
      createEmployee(ctx, { displayName: "Wrong Org", phone: "+15005550013" }),
    );

    await expect(
      inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
        transferCall(ctx, {
          communicationId: communication.id,
          toEmployeeId: otherOrgEmployee.id,
          reason: "caller_requested_human",
          idempotencyKey: `transfer-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a transfer target with no phone on file", async () => {
    const communication = await openVoiceCall(w.orgA.id);
    const employee = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createEmployee(ctx, { displayName: "No Phone" }),
    );

    await expect(
      inOrg(w.db, receptionist, w.orgA.id, (ctx) =>
        transferCall(ctx, {
          communicationId: communication.id,
          toEmployeeId: employee.id,
          reason: "caller_requested_human",
          idempotencyKey: `transfer-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("denies actors without communication.write, e.g. a field employee", async () => {
    const communication = await openVoiceCall(w.orgA.id);
    const employee = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createEmployee(ctx, { displayName: "Denied Target", phone: "+15005550014" }),
    );

    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        transferCall(ctx, {
          communicationId: communication.id,
          toEmployeeId: employee.id,
          reason: "caller_requested_human",
          idempotencyKey: `transfer-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
