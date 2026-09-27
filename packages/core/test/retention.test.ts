// Retention purge (M2-T25): payload bodies clear only for successfully processed webhook events
// past their organization's own window; transcripts/summaries clear only for ended communications
// past theirs. Everything still in flight, and every organization's own window, is respected.
// The audit/event trail written around these purges is covered in packages/workflows/test.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@backoffice/domain";
import { purgeExpiredCommunications, purgeExpiredWebhookPayloads } from "../src";
import { asTx } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const worker: Actor = { type: "system", name: "retention-test" };

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

type WebhookRow = { payload: Record<string, unknown>; payload_purged_at: string | null };
type CommRow = {
  summary: string | null;
  transcript: string | null;
  structured_extraction: Record<string, unknown>;
  retention_status: string;
};

async function insertWebhookEvent(
  orgId: string | null,
  status: string,
  processedAtDaysAgo: number | null,
) {
  const key = `evt-${randomUUID()}`;
  const processedAt = processedAtDaysAgo == null ? null : daysAgo(processedAtDaysAgo);
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.webhook_receipts
       (provider, provider_event_id, organization_id, payload_hash, status, payload, processed_at)
     values ('test', $1, $2, 'hash', $3, '{"secret":"raw body"}'::jsonb, $4) returning id`,
    [key, orgId, status, processedAt],
  );
  return { id: (rows[0] as { id: string }).id, key };
}

async function insertCommunication(orgId: string, status: string, endedAtDaysAgo: number | null) {
  const startedAt = daysAgo((endedAtDaysAgo ?? 0) + 1);
  const endedAt = endedAtDaysAgo == null ? null : daysAgo(endedAtDaysAgo);
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.communications
       (organization_id, channel, direction, status, started_at, ended_at, summary, transcript)
     values ($1, 'voice', 'inbound', $2, $3, $4, 'a sensitive summary', 'a sensitive transcript')
     returning id`,
    [orgId, status, startedAt, endedAt],
  );
  return (rows[0] as { id: string }).id;
}

const webhookRow = async (id: string): Promise<WebhookRow> =>
  (
    await w.pg.query<WebhookRow>(
      `select payload, payload_purged_at from public.webhook_receipts where id = $1`,
      [id],
    )
  ).rows[0] as WebhookRow;

const communicationRow = async (id: string): Promise<CommRow> =>
  (
    await w.pg.query<CommRow>(
      `select summary, transcript, structured_extraction, retention_status
         from public.communications where id = $1`,
      [id],
    )
  ).rows[0] as CommRow;

describe("purgeExpiredWebhookPayloads", () => {
  it("clears the payload of a processed event past the org's window, keeping its identity", async () => {
    await w.pg.query(
      `update public.organizations set webhook_payload_retention_days = 1 where id = $1`,
      [w.orgA.id],
    );
    const due = await insertWebhookEvent(w.orgA.id, "processed", 2);

    const batches = await asTx(w.db, worker, (tx) => purgeExpiredWebhookPayloads(tx));
    expect(batches).toContainEqual({ organizationId: w.orgA.id, count: 1 });

    const row = await webhookRow(due.id);
    expect(row.payload).toEqual({});
    expect(row.payload_purged_at).not.toBeNull();
    const identity = await w.pg.query<{ provider_event_id: string }>(
      `select provider_event_id from public.webhook_receipts where id = $1`,
      [due.id],
    );
    expect(identity.rows[0]?.provider_event_id).toBe(due.key);
  });

  it.each([
    {
      label: "processed but still inside its window",
      status: "processed",
      org: () => w.orgA.id,
      days: 0,
    },
    { label: "received", status: "received", org: () => w.orgA.id, days: null },
    { label: "processing", status: "processing", org: () => w.orgA.id, days: null },
    { label: "failed", status: "failed", org: () => w.orgA.id, days: 30 },
    { label: "dead", status: "dead", org: () => w.orgA.id, days: 30 },
    { label: "unroutable", status: "unroutable", org: () => null, days: 30 },
  ])("never touches a $label event, even one that looks old", async ({ status, org, days }) => {
    const untouched = await insertWebhookEvent(org(), status, days);
    await asTx(w.db, worker, (tx) => purgeExpiredWebhookPayloads(tx));
    const row = await webhookRow(untouched.id);
    expect(row.payload).toEqual({ secret: "raw body" });
    expect(row.payload_purged_at).toBeNull();
  });

  it("is idempotent, and applies each organization's own window independently", async () => {
    await w.pg.query(
      `update public.organizations set webhook_payload_retention_days = 100 where id = $1`,
      [w.orgB.id],
    );
    const orgAEvent = await insertWebhookEvent(w.orgA.id, "ignored", 2);
    const orgBEvent = await insertWebhookEvent(w.orgB.id, "ignored", 2);

    const batches = await asTx(w.db, worker, (tx) => purgeExpiredWebhookPayloads(tx));
    expect(batches).toContainEqual({ organizationId: w.orgA.id, count: 1 });
    expect(batches.find((b) => b.organizationId === w.orgB.id)).toBeUndefined();
    expect((await webhookRow(orgAEvent.id)).payload).toEqual({});
    expect((await webhookRow(orgBEvent.id)).payload).toEqual({ secret: "raw body" });

    const again = await asTx(w.db, worker, (tx) => purgeExpiredWebhookPayloads(tx));
    expect(again.find((b) => b.organizationId === w.orgA.id)).toBeUndefined();
  });
});

describe("purgeExpiredCommunications", () => {
  it("clears content of an ended communication past the org's window, keeping identity", async () => {
    await w.pg.query(
      `update public.organizations set communication_retention_days = 1 where id = $1`,
      [w.orgA.id],
    );
    const id = await insertCommunication(w.orgA.id, "completed", 2);

    const batches = await asTx(w.db, worker, (tx) => purgeExpiredCommunications(tx));
    expect(batches).toContainEqual({ organizationId: w.orgA.id, count: 1 });
    expect(await communicationRow(id)).toMatchObject({
      summary: null,
      transcript: null,
      structured_extraction: {},
      retention_status: "deleted",
    });
  });

  it("purges any terminal status, never one still in progress, and is idempotent", async () => {
    const abandoned = await insertCommunication(w.orgA.id, "abandoned", 2);
    const failed = await insertCommunication(w.orgA.id, "failed", 2);
    const stillGoing = await insertCommunication(w.orgA.id, "in_progress", null);

    await asTx(w.db, worker, (tx) => purgeExpiredCommunications(tx));
    expect((await communicationRow(abandoned)).retention_status).toBe("deleted");
    expect((await communicationRow(failed)).retention_status).toBe("deleted");
    expect(await communicationRow(stillGoing)).toMatchObject({
      retention_status: "active",
      transcript: "a sensitive transcript",
    });

    const again = await asTx(w.db, worker, (tx) => purgeExpiredCommunications(tx));
    expect(again).toEqual([]);
  });

  it("never touches a communication still inside its window", async () => {
    const recent = await insertCommunication(w.orgA.id, "completed", 0);
    await asTx(w.db, worker, (tx) => purgeExpiredCommunications(tx));
    expect(await communicationRow(recent)).toMatchObject({
      retention_status: "active",
      transcript: "a sensitive transcript",
    });
  });
});
