// M2-T24: ops console visibility and remediation for dead-lettered webhook events. Access follows
// the same grant model as ops cases (ops-access.test.ts). Outbound operation coverage lives in
// ops-outbound.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, type UUID } from "@backoffice/domain";
import {
  cancelDeadWebhookEvent,
  grantOperatorAccess,
  listStuckWebhookEvents,
  retryDeadWebhookEvent,
  revokeOperatorAccess,
} from "../src";
import { asTx, count, inOrg, operatorActor, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const op = () => operatorActor(w.operator);

async function insertWebhookEvent(orgId: UUID | null, status: string, eventKey: string) {
  const { rows } = await w.pg.query<{ id: UUID }>(
    `insert into public.webhook_receipts (provider, provider_event_id, organization_id, status)
     values ('twilio', $1, $2, $3) returning id`,
    [eventKey, orgId, status],
  );
  return (rows[0] as { id: UUID }).id;
}

const grantOrgA = () =>
  inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
    grantOperatorAccess(ctx, {
      operatorEmail: "operator@backoffice.test",
      reason: "stuck ops review",
    }),
  );
const revoke = (grantId: UUID) =>
  inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) => revokeOperatorAccess(ctx, grantId));

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

describe("stuck webhook events", () => {
  it("dead events need a grant; unrouted events (no tenant yet) are visible to any staff", async () => {
    const deadId = await insertWebhookEvent(w.orgA.id, "dead", "dead-1");
    const unroutedId = await insertWebhookEvent(null, "unroutable", "unrouted-1");

    const noGrant = await asTx(w.db, op(), (tx) => listStuckWebhookEvents(tx));
    expect(noGrant.dead).toEqual([]);
    expect(noGrant.unrouted.map((e) => e.id)).toContain(unroutedId);
    await expect(
      asTx(w.db, op(), (tx) => retryDeadWebhookEvent(tx, deadId)),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const grant = await grantOrgA();
    try {
      const withGrant = await asTx(w.db, op(), (tx) => listStuckWebhookEvents(tx));
      expect(withGrant.dead.map((e) => e.id)).toContain(deadId);
      expect(withGrant.dead.find((e) => e.id === deadId)?.organizationName).toBe("Org A");

      const retried = await asTx(w.db, op(), (tx) => retryDeadWebhookEvent(tx, deadId));
      expect(retried.status).toBe("received");
      expect(
        await count(
          w.pg,
          `select 1 from public.audit_log where action = 'webhook_event.retried' and entity_id = $1`,
          [deadId],
        ),
      ).toBe(1);

      await expect(
        asTx(w.db, op(), (tx) => retryDeadWebhookEvent(tx, deadId)),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      await revoke(grant.id);
    }
  });

  it("cancel marks a dead event ignored and is audited", async () => {
    const grant = await grantOrgA();
    try {
      const id = await insertWebhookEvent(w.orgA.id, "dead", "dead-2");
      const cancelled = await asTx(w.db, op(), (tx) => cancelDeadWebhookEvent(tx, id));
      expect(cancelled.status).toBe("ignored");
      expect(
        await count(
          w.pg,
          `select 1 from public.audit_log where action = 'webhook_event.cancelled' and entity_id = $1`,
          [id],
        ),
      ).toBe(1);
    } finally {
      await revoke(grant.id);
    }
  });
});

describe("console access", () => {
  it("a regular tenant user cannot use the operator console at all", async () => {
    await expect(
      asTx(w.db, userActor(w.orgA.owner), (tx) => listStuckWebhookEvents(tx)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
