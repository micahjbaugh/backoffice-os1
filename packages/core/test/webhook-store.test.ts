// Webhook event store and outbox tables (0012): server-only access, identity and retry bookkeeping.
// End-to-end pipeline behavior (duplicates, ordering, crashes) is in packages/workflows/test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@backoffice/domain";
import {
  acceptWebhookEvent,
  claimWebhookEvents,
  failWebhookEvent,
  retryDelaySeconds,
  outboundRetryDelaySeconds,
  stableStringify,
  type AcceptWebhookInput,
} from "../src";
import { asTx, rawAsUser } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const integration: Actor = { type: "integration", name: "store-test" };
const ROUTED = "+15125550100";

beforeAll(async () => {
  w = await createWorld();
  await w.pg.query(
    `insert into public.provider_routes (organization_id, provider, channel, address) values ($1, 'twilio', 'sms', $2)`,
    [w.orgA.id, ROUTED],
  );
});
afterAll(async () => {
  await w.close();
});

const input = (key: string, rawBody = `body-${key}`): AcceptWebhookInput => ({
  provider: "twilio",
  channel: "sms",
  eventType: "sms.inbound",
  eventKey: key,
  resourceId: key.split(":")[0] as string,
  deliveryId: null,
  occurredAt: null,
  routingAddress: ROUTED,
  payload: { body: "hello" },
  rawBody,
});

describe("access control", () => {
  it("tenant members see no webhook_receipts rows (RLS is grant-only) and cannot write them", async () => {
    for (const user of [w.orgA.owner, w.orgA.manager]) {
      const { rows } = await rawAsUser(w.pg, user, `select * from public.webhook_receipts`);
      expect(rows).toHaveLength(0);
      await expect(
        rawAsUser(w.pg, user, `update public.webhook_receipts set status = 'processed'`),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("staff can see their own org's outbound operations, never another org's, and cannot write them", async () => {
    await w.pg.query(
      `insert into public.outbound_operations (organization_id, operation_type, idempotency_key, request_hash, request, created_by_actor_type)
       values ($1, 'sms.send', 'visible-a', 'h', '{}', 'system'), ($2, 'sms.send', 'hidden-b', 'h', '{}', 'system')`,
      [w.orgA.id, w.orgB.id],
    );
    const seen = await rawAsUser<{ idempotency_key: string }>(
      w.pg,
      w.orgA.manager,
      `select idempotency_key from public.outbound_operations`,
    );
    expect(seen.rows.map((r) => r.idempotency_key)).toEqual(["visible-a"]);
    const field = await rawAsUser(
      w.pg,
      w.orgA.fieldEmployee,
      `select * from public.outbound_operations`,
    );
    expect(field.rows).toHaveLength(0);
    await expect(
      rawAsUser(w.pg, w.orgA.owner, `update public.outbound_operations set status = 'succeeded'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.outbound_operations (organization_id, operation_type, idempotency_key, request_hash, request, created_by_actor_type) values ($1, 'sms.send', 'forged', 'h', '{}', 'user')`,
        [w.orgA.id],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("owners can see their routes but nobody can change them from a client", async () => {
    const own = await rawAsUser<{ address: string }>(
      w.pg,
      w.orgA.owner,
      `select address from public.provider_routes`,
    );
    expect(own.rows.map((r) => r.address)).toEqual([ROUTED]);
    const other = await rawAsUser(w.pg, w.orgB.owner, `select * from public.provider_routes`);
    expect(other.rows).toHaveLength(0);
    await expect(
      rawAsUser(
        w.pg,
        w.orgB.owner,
        `insert into public.provider_routes (organization_id, provider, channel, address) values ($1, 'twilio', 'sms', $2)`,
        [w.orgB.id, ROUTED],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rawAsUser(w.pg, w.orgA.owner, `update public.provider_routes set active = false`),
    ).rejects.toThrow(/permission denied/);
  });

  it("one active route per provider address across all tenants", async () => {
    await expect(
      w.pg.query(
        `insert into public.provider_routes (organization_id, provider, channel, address) values ($1, 'twilio', 'sms', $2)`,
        [w.orgB.id, ROUTED],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("acceptance", () => {
  it("a retry with a different body is flagged, and the first delivery is kept", async () => {
    const first = await asTx(w.db, integration, (tx) =>
      acceptWebhookEvent(tx, input("SM1:inbound", "original")),
    );
    const tampered = await asTx(w.db, integration, (tx) =>
      acceptWebhookEvent(tx, input("SM1:inbound", "different")),
    );
    expect(first).toMatchObject({ duplicate: false, payloadMismatch: false });
    expect(tampered).toMatchObject({ duplicate: true, payloadMismatch: true });
    expect(tampered.event.payloadHash).toBe(first.event.payloadHash);
  });
});

describe("retry bookkeeping", () => {
  it("backoff grows and is capped", () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 60, 120, 240]);
    expect(retryDelaySeconds(50)).toBe(3600);
    expect(outboundRetryDelaySeconds(50)).toBe(1800);
  });

  it("a claimed event is invisible to other workers until its lock expires", async () => {
    await asTx(w.db, integration, (tx) => acceptWebhookEvent(tx, input("SM2:inbound")));
    const a = await claimWebhookEvents(w.db, { limit: 50 });
    const b = await claimWebhookEvents(w.db, { limit: 50 });
    expect(a.map((e) => e.eventKey)).toContain("SM2:inbound");
    expect(b.map((e) => e.eventKey)).not.toContain("SM2:inbound");
    const event = a.find((e) => e.eventKey === "SM2:inbound");
    if (!event) throw new Error("not claimed");
    expect(
      await asTx(w.db, integration, (tx) =>
        failWebhookEvent(tx, { ...event, attempts: event.maxAttempts }, "boom"),
      ),
    ).toBe("dead");
  });

  it("request hashing ignores key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
});
