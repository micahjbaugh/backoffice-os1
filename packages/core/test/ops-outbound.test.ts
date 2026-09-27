// M2-T24: ops console visibility and remediation for failed/unknown outbound operations. Access
// follows the same grant model as ops cases (ops-access.test.ts); the specific rule under test here
// is that an outcome-`unknown` operation can never be retried. Webhook event coverage lives in
// ops-operations.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, type UUID } from "@backoffice/domain";
import {
  cancelOutboundOperation,
  grantOperatorAccess,
  listStuckOutboundOperations,
  reconcileUnknownOutboundOperation,
  retryFailedOutboundOperation,
  revokeOperatorAccess,
} from "../src";
import { asTx, count, inOrg, operatorActor, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const op = () => operatorActor(w.operator);

async function insertOutboundOperation(orgId: UUID, status: string, key: string) {
  const { rows } = await w.pg.query<{ id: UUID }>(
    `insert into public.outbound_operations
       (organization_id, operation_type, idempotency_key, request_hash, request, status, created_by_actor_type)
     values ($1, 'sms.send', $2, 'h', '{}', $3, 'system') returning id`,
    [orgId, key, status],
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

describe("stuck outbound operations", () => {
  it("an unknown-outcome operation can never be retried from the console", async () => {
    const grant = await grantOrgA();
    try {
      const id = await insertOutboundOperation(w.orgA.id, "unknown", "unk-1");
      await expect(
        asTx(w.db, op(), (tx) => retryFailedOutboundOperation(tx, id)),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      await revoke(grant.id);
    }
  });

  it("retry works for failed operations and is tenant-scoped", async () => {
    const failedB = await insertOutboundOperation(w.orgB.id, "failed", "fail-b");
    await expect(
      asTx(w.db, op(), (tx) => retryFailedOutboundOperation(tx, failedB)),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const grant = await grantOrgA();
    try {
      const failedA = await insertOutboundOperation(w.orgA.id, "failed", "fail-a");
      const retried = await asTx(w.db, op(), (tx) => retryFailedOutboundOperation(tx, failedA));
      expect(retried.status).toBe("pending");
      expect(retried.attempts).toBe(0);

      const listed = await asTx(w.db, op(), (tx) => listStuckOutboundOperations(tx));
      expect(listed.map((o) => o.id)).not.toContain(failedA);
    } finally {
      await revoke(grant.id);
    }
  });

  it("cancel stops an operation permanently and is audited", async () => {
    const grant = await grantOrgA();
    try {
      const id = await insertOutboundOperation(w.orgA.id, "pending", "cancel-1");
      const cancelled = await asTx(w.db, op(), (tx) => cancelOutboundOperation(tx, id));
      expect(cancelled.status).toBe("cancelled");
      expect(
        await count(
          w.pg,
          `select 1 from public.audit_log where action = 'outbound_operation.cancelled' and entity_id = $1`,
          [id],
        ),
      ).toBe(1);
    } finally {
      await revoke(grant.id);
    }
  });

  it("reconciling 'did not happen' unlocks retry; 'succeeded' resolves it directly", async () => {
    const grant = await grantOrgA();
    try {
      const id = await insertOutboundOperation(w.orgA.id, "unknown", "unk-2");
      const reconciled = await asTx(w.db, op(), (tx) =>
        reconcileUnknownOutboundOperation(tx, id, { kind: "did_not_happen" }),
      );
      expect(reconciled.status).toBe("failed");
      expect(
        await count(
          w.pg,
          `select 1 from public.audit_log where action = 'outbound_operation.reconciled' and entity_id = $1`,
          [id],
        ),
      ).toBe(1);
      const retried = await asTx(w.db, op(), (tx) => retryFailedOutboundOperation(tx, id));
      expect(retried.status).toBe("pending");

      const succeededId = await insertOutboundOperation(w.orgA.id, "unknown", "unk-3");
      const succeeded = await asTx(w.db, op(), (tx) =>
        reconcileUnknownOutboundOperation(tx, succeededId, {
          kind: "succeeded",
          providerRef: "SM123",
        }),
      );
      expect(succeeded.status).toBe("succeeded");
      expect(succeeded.providerRef).toBe("SM123");
    } finally {
      await revoke(grant.id);
    }
  });
});

describe("console access", () => {
  it("a regular tenant user cannot use the operator console at all", async () => {
    await expect(
      asTx(w.db, userActor(w.orgA.owner), (tx) => listStuckOutboundOperations(tx)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
