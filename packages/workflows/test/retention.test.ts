// M2-T25: the scheduled purge itself is tested at packages/core/test/retention.test.ts. This
// covers the workflow layer wrapped around it: an event + audit entry per organization actually
// touched (CLAUDE.md rule 8), none for organizations with nothing due, and no duplicate trail on
// a re-run once a batch is already empty.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeExpiredRetention } from "../src";
import { count, createWorld, type World } from "./helpers";

let w: World;

beforeAll(async () => {
  w = await createWorld();
  await w.pg.query(
    `update public.organizations
        set webhook_payload_retention_days = 1, communication_retention_days = 1
      where id = $1`,
    [w.orgA.id],
  );
  await w.pg.query(
    `insert into public.webhook_receipts
       (provider, provider_event_id, organization_id, payload_hash, status, payload, processed_at)
     values ('test', 'evt-due', $1, 'hash', 'processed', '{"secret":"x"}'::jsonb, now() - interval '2 days')`,
    [w.orgA.id],
  );
  await w.pg.query(
    `insert into public.communications
       (organization_id, channel, direction, status, started_at, ended_at, summary, transcript)
     values ($1, 'voice', 'inbound', 'completed', now() - interval '3 days', now() - interval '2 days',
             'sensitive summary', 'sensitive transcript')`,
    [w.orgA.id],
  );
});
afterAll(async () => {
  await w.close();
});

const events = (organizationId: string, type: string) =>
  count(w.pg, `select 1 from public.business_events where organization_id = $1 and type = $2`, [
    organizationId,
    type,
  ]);
const audits = (organizationId: string, action: string) =>
  count(w.pg, `select 1 from public.audit_log where organization_id = $1 and action = $2`, [
    organizationId,
    action,
  ]);

describe("purgeExpiredRetention", () => {
  it("records one purge summary, an event and an audit entry per organization actually touched", async () => {
    const summary = await purgeExpiredRetention(w.db);
    expect(summary).toEqual({ webhookPayloadsPurged: 1, communicationsPurged: 1 });

    expect(await events(w.orgA.id, "webhook.payloads_purged")).toBe(1);
    expect(await events(w.orgA.id, "communication.retention_purged")).toBe(1);
    expect(await audits(w.orgA.id, "retention.webhook_payloads_purged")).toBe(1);
    expect(await audits(w.orgA.id, "retention.communications_purged")).toBe(1);

    const auditDetails = await w.pg.query<{ details: { count: number } }>(
      `select details from public.audit_log where organization_id = $1 and action = $2`,
      [w.orgA.id, "retention.webhook_payloads_purged"],
    );
    expect(auditDetails.rows[0]?.details).toMatchObject({ count: 1 });
  });

  it("writes nothing for an organization with nothing due", async () => {
    expect(await events(w.orgB.id, "webhook.payloads_purged")).toBe(0);
    expect(await events(w.orgB.id, "communication.retention_purged")).toBe(0);
    expect(await audits(w.orgB.id, "retention.webhook_payloads_purged")).toBe(0);
    expect(await audits(w.orgB.id, "retention.communications_purged")).toBe(0);
  });

  it("a re-run over an already-purged batch adds nothing new", async () => {
    const summary = await purgeExpiredRetention(w.db);
    expect(summary).toEqual({ webhookPayloadsPurged: 0, communicationsPurged: 0 });
    expect(await events(w.orgA.id, "webhook.payloads_purged")).toBe(1);
    expect(await audits(w.orgA.id, "retention.communications_purged")).toBe(1);
  });
});
