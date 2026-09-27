// M3-T16: an inbound SMS from a known employee phone (M2 webhook pipeline) is routed to the field
// capture workflow instead of getting the M2-T23 acknowledgement. Uses the fake SMS provider (not
// Twilio wire format) to exercise the generic webhook -> handler -> field-capture path end to end
// against a real database, and proves a redelivered event (provider retry or crash-recovery
// reprocessing) drafts nothing twice, because field capture's own idempotency marker
// (`field_capture.processed:<communicationId>`) short-circuits the replay before the extractor
// even runs again.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  FieldCaptureExtraction,
  FieldCaptureFact,
  StructuredExtractor,
} from "@backoffice/domain";
import { FakeSmsProvider, type FakeWebhookEnvelope } from "@backoffice/integrations";
import { createWebhookHandlers, processWebhookEvents } from "../src";
import { count, createWorld, deliver, type World } from "./helpers";

const SECRET = "field-capture-sms-test-secret-01";
const BUSINESS_NUMBER = "+15125550200";
const EMPLOYEE_NUMBER = "+15125550166";

const fakeSms = new FakeSmsProvider(SECRET);

function fakeSmsRequest(envelope: FakeWebhookEnvelope) {
  const signed = fakeSms.signWebhook(envelope);
  return {
    rawBody: signed.rawBody,
    headers: new Headers(signed.headers),
    url: "http://internal:3000/api/webhooks/sms",
  };
}

const TIME_ENTRY_FACT: FieldCaptureFact = {
  factKey: "time-1",
  type: "time_entry",
  fields: { employeeRef: "Jake Tyler", jobRef: "Wilson", startTime: "7:00", endTime: "5:30" },
  confidence: { employeeRef: 0.95, jobRef: 0.9, startTime: 0.9, endTime: 0.9 },
  evidence: [{ field: "employeeRef", quote: "Me Jake Tyler 7-5:30 Wilson" }],
};

/** Ignores the message text entirely (routing correctness is this test's concern, not extraction
 *  quality, which M3-T09/T10 already cover): always returns the same fact and counts its calls, so
 *  a replay that skips extraction is directly observable. */
class CountingExtractor implements StructuredExtractor<FieldCaptureExtraction> {
  calls = 0;
  async extract() {
    this.calls += 1;
    return {
      data: { facts: [TIME_ENTRY_FACT], unresolvedQuestions: [] },
      modelVersion: "test-1",
    };
  }
}

let w: World;
let jobId: string;

beforeAll(async () => {
  w = await createWorld();
  await w.pg.query(
    `insert into public.provider_routes (organization_id, provider, channel, address) values ($1, 'fake-sms', 'sms', $2)`,
    [w.orgA.id, BUSINESS_NUMBER],
  );
  await w.pg.query(
    `insert into public.employees (organization_id, display_name, phone) values ($1, 'Jake Tyler', $2)`,
    [w.orgA.id, EMPLOYEE_NUMBER],
  );
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.jobs (organization_id, name, status) values ($1, 'Wilson Job', 'active') returning id`,
    [w.orgA.id],
  );
  jobId = (rows[0] as { id: string }).id;
});
afterAll(async () => {
  await w.close();
});

describe("inbound SMS from a known employee", () => {
  it("drafts a time entry through field capture instead of sending an acknowledgement, and a redelivered event drafts nothing new", async () => {
    const extractor = new CountingExtractor();
    const handlers = createWebhookHandlers(extractor);
    const envelope: FakeWebhookEnvelope = {
      eventType: "sms.inbound",
      eventKey: "fc-msg-1",
      resourceId: "fc-msg-1",
      routingAddress: BUSINESS_NUMBER,
      payload: {
        from: EMPLOYEE_NUMBER,
        to: BUSINESS_NUMBER,
        body: "Me Jake Tyler 7-5:30 Wilson",
        messageSid: "fc-msg-1",
      },
    };

    await deliver(w, fakeSms, fakeSmsRequest(envelope));
    await processWebhookEvents(w.db, { handlers });

    expect(extractor.calls).toBe(1);
    const timeEntries = await w.pg.query<{ status: string; hours: string }>(
      `select status, hours from public.time_entries where job_id = $1`,
      [jobId],
    );
    expect(timeEntries.rows).toHaveLength(1);
    expect(timeEntries.rows[0]).toMatchObject({ status: "draft" });
    expect(
      await count(
        w.pg,
        `select 1 from public.outbound_operations where organization_id = $1 and operation_type = 'sms.send'`,
        [w.orgA.id],
      ),
    ).toBe(0);

    // Provider retry / crash-recovery reprocessing of the same event.
    await w.pg.query(
      `update public.webhook_receipts set status = 'received' where provider = 'fake-sms' and provider_event_id = $1`,
      ["fc-msg-1"],
    );
    await processWebhookEvents(w.db, { handlers });

    expect(extractor.calls).toBe(1);
    expect(await count(w.pg, `select 1 from public.time_entries where job_id = $1`, [jobId])).toBe(
      1,
    );
  });
});
