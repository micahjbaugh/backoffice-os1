// Finding 6: durable outbound operations. Proves: intent is recorded atomically with the domain
// change; the provider is called outside any transaction, once; rejected-and-retryable attempts are
// bounded; ambiguous outcomes (timeout, crash) are never re-sent blindly but reconciled or escalated;
// concurrent workers and process restarts do not double-execute.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, type Actor } from "@backoffice/domain";
import {
  claimOutboundOperations,
  enqueueOutboundOperation,
  inTenant,
  recordCall,
  requestOutboundSms,
  runAs,
  transferCall,
} from "@backoffice/core";
import {
  FakeSmsProvider,
  FakeVoiceProvider,
  FixtureStructuredExtractor,
  type ProviderRuntime,
} from "@backoffice/integrations";
import {
  dispatchOutboundOperations,
  reconcileUnknownOperations,
  processWebhookEvents,
} from "../src";
import {
  BUSINESS_NUMBER,
  count,
  createWorld,
  CUSTOMER_NUMBER,
  deliver,
  makeEverythingDue,
  setupRoutes,
  twilio,
  twilioRequest,
  twilioStatusCallback,
  type World,
} from "./helpers";

const SECRET = "outbox-test-webhook-secret-01";
let w: World;
let employeeId: string;
const owner = (): Actor => ({ type: "user", userId: w.orgA.owner });

beforeAll(async () => {
  w = await createWorld();
  await setupRoutes(w);
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.employees (organization_id, display_name, phone) values ($1, 'Dispatcher Dana', '+15125550123') returning id`,
    [w.orgA.id],
  );
  employeeId = (rows[0] as { id: string }).id;
});
afterAll(async () => {
  await w.close();
});

/** A fresh runtime = a fresh process: nothing carried over in memory. */
function runtime(): ProviderRuntime & { sms: FakeSmsProvider; voice: FakeVoiceProvider } {
  return {
    mode: "fake",
    sms: new FakeSmsProvider(SECRET),
    voice: new FakeVoiceProvider(SECRET),
    extractor: new FixtureStructuredExtractor(),
  };
}

async function liveCall(): Promise<{ communicationId: string; providerCallId: string }> {
  const providerCallId = `call-${randomUUID()}`;
  const { communication } = await runAs(w.db, owner(), (tx) =>
    recordCall(inTenant(tx, w.orgA.id), {
      direction: "inbound",
      provider: "fake-voice",
      providerConversationId: providerCallId,
      providerCallId,
    }),
  );
  return { communicationId: communication.id, providerCallId };
}

const requestTransfer = (communicationId: string, key = `transfer-${randomUUID()}`) =>
  runAs(w.db, owner(), (tx) =>
    transferCall(inTenant(tx, w.orgA.id), {
      communicationId,
      toEmployeeId: employeeId,
      reason: "caller_requested_human",
      idempotencyKey: key,
    }),
  );

const opRow = async (id: string) =>
  (
    await w.pg.query<{
      status: string;
      attempts: number;
      ops_case_id: string | null;
      last_error: string | null;
    }>(
      `select status, attempts, ops_case_id, last_error from public.outbound_operations where id = $1`,
      [id],
    )
  ).rows[0];

describe("recording intent", () => {
  it("a transfer request queues an operation with event + audit and does not call the provider", async () => {
    const rt = runtime();
    const { communicationId } = await liveCall();
    const result = await requestTransfer(communicationId);
    expect(result).toMatchObject({ status: "pending", created: true, toEmployeeId: employeeId });
    expect(rt.voice.transfers).toHaveLength(0);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'communication.transfer_requested' and entity_id = $1`,
        [communicationId],
      ),
    ).toBe(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'communication.transfer_requested' and entity_id = $1`,
        [communicationId],
      ),
    ).toBe(1);
  });

  it("retrying the request with the same key queues nothing new; a different request with that key conflicts", async () => {
    const { communicationId } = await liveCall();
    const key = `transfer-${randomUUID()}`;
    const first = await requestTransfer(communicationId, key);
    const again = await requestTransfer(communicationId, key);
    expect(again).toMatchObject({ operationId: first.operationId, created: false });
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'communication.transfer_requested' and entity_id = $1`,
        [communicationId],
      ),
    ).toBe(1);

    await expect(
      runAs(w.db, { type: "system", name: "t" }, (tx) =>
        enqueueOutboundOperation(inTenant(tx, w.orgA.id), {
          operationType: "call.transfer",
          idempotencyKey: key,
          request: { providerCallId: "other" },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("keys are scoped by tenant and operation type", async () => {
    const key = `shared-${randomUUID()}`;
    const enqueue = (orgId: string, type: string) =>
      runAs(w.db, { type: "system", name: "t" }, (tx) =>
        enqueueOutboundOperation(inTenant(tx, orgId), {
          operationType: type,
          idempotencyKey: key,
          request: { x: 1 },
        }),
      );
    const a = await enqueue(w.orgA.id, "test.op");
    const b = await enqueue(w.orgB.id, "test.op");
    const c = await enqueue(w.orgA.id, "test.other");
    expect(new Set([a.operation.id, b.operation.id, c.operation.id]).size).toBe(3);
    await w.pg.query(
      `update public.outbound_operations set status = 'cancelled' where idempotency_key = $1`,
      [key],
    );
  });
});

describe("execution", () => {
  it("executes once, records the provider result and the transferred event; later runs find nothing", async () => {
    const rt = runtime();
    const { communicationId, providerCallId } = await liveCall();
    const { operationId } = await requestTransfer(communicationId);
    const summary = await dispatchOutboundOperations(w.db, rt);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);
    expect(rt.voice.transfers.filter((t) => t.providerCallId === providerCallId)).toHaveLength(1);
    expect(await opRow(operationId)).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'communication.transferred' and entity_id = $1`,
        [communicationId],
      ),
    ).toBe(1);
    await dispatchOutboundOperations(w.db, rt);
    expect(rt.voice.transfers.filter((t) => t.providerCallId === providerCallId)).toHaveLength(1);
  });

  it("concurrent workers never execute the same operation twice", async () => {
    const rt = runtime();
    const calls = await Promise.all([1, 2, 3].map(() => liveCall()));
    for (const c of calls) await requestTransfer(c.communicationId);
    await Promise.all([
      dispatchOutboundOperations(w.db, rt),
      dispatchOutboundOperations(w.db, rt),
      dispatchOutboundOperations(w.db, rt),
    ]);
    for (const c of calls) {
      expect(rt.voice.transfers.filter((t) => t.providerCallId === c.providerCallId)).toHaveLength(
        1,
      );
    }
  });

  it("a restarted process (new runtime, empty memory) completes pending work exactly once", async () => {
    const { communicationId, providerCallId } = await liveCall();
    await requestTransfer(communicationId);
    const afterRestart = runtime();
    await dispatchOutboundOperations(w.db, afterRestart);
    await dispatchOutboundOperations(w.db, runtime());
    expect(
      afterRestart.voice.transfers.filter((t) => t.providerCallId === providerCallId),
    ).toHaveLength(1);
  });
});

describe("failures", () => {
  it("rejected + retryable (e.g. 429) retries with backoff, bounded, then fails to a person", async () => {
    const rt = runtime();
    const { communicationId } = await liveCall();
    const { operationId } = await requestTransfer(communicationId);
    await w.pg.query(`update public.outbound_operations set max_attempts = 2 where id = $1`, [
      operationId,
    ]);
    rt.voice.scriptFailures(
      { kind: "rejected", retryable: true },
      { kind: "rejected", retryable: true },
    );

    await dispatchOutboundOperations(w.db, rt);
    expect(await opRow(operationId)).toMatchObject({ status: "pending", attempts: 1 });
    expect((await dispatchOutboundOperations(w.db, rt)).claimed).toBe(0); // backoff not elapsed
    await makeEverythingDue(w);
    await dispatchOutboundOperations(w.db, rt);
    const row = await opRow(operationId);
    expect(row).toMatchObject({ status: "failed", attempts: 2 });
    expect(row?.ops_case_id).not.toBeNull();
    expect(rt.voice.transfers).toHaveLength(0);
  });

  it("an ambiguous outcome is never retried; reconciliation confirms it with the provider", async () => {
    const rt = runtime();
    const { communicationId, providerCallId } = await liveCall();
    const { operationId } = await requestTransfer(communicationId);
    rt.voice.scriptFailures({ kind: "ambiguous", performed: true }); // provider acted, response lost

    await dispatchOutboundOperations(w.db, rt);
    expect(await opRow(operationId)).toMatchObject({ status: "unknown" });
    await makeEverythingDue(w);
    await dispatchOutboundOperations(w.db, rt);
    expect(rt.voice.transfers.filter((t) => t.providerCallId === providerCallId)).toHaveLength(1); // not re-sent

    const result = await reconcileUnknownOperations(w.db, rt);
    expect(result.reconciled).toBeGreaterThanOrEqual(1);
    expect(await opRow(operationId)).toMatchObject({ status: "succeeded" });
    expect(rt.voice.transfers.filter((t) => t.providerCallId === providerCallId)).toHaveLength(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'communication.transferred' and entity_id = $1`,
        [communicationId],
      ),
    ).toBe(1);
  });

  it("an ambiguous outcome the provider cannot confirm is escalated to a person once, not re-sent", async () => {
    const rt = runtime();
    const { communicationId, providerCallId } = await liveCall();
    const { operationId } = await requestTransfer(communicationId);
    rt.voice.scriptFailures({ kind: "ambiguous", performed: false });
    rt.voice.setCallStatus(providerCallId, "in-progress");

    await dispatchOutboundOperations(w.db, rt);
    await reconcileUnknownOperations(w.db, rt);
    await reconcileUnknownOperations(w.db, rt);
    const row = await opRow(operationId);
    expect(row?.status).toBe("unknown");
    expect(
      await count(w.pg, `select 1 from public.ops_cases where evidence->>'operation_id' = $1`, [
        operationId,
      ]),
    ).toBe(1);
    expect(rt.voice.transfers.filter((t) => t.providerCallId === providerCallId)).toHaveLength(0);
  });

  it("a worker that crashes after the provider call (before recording) leaves it unknown, then reconciled", async () => {
    const rt = runtime();
    const { communicationId, providerCallId } = await liveCall();
    const { operationId } = await requestTransfer(communicationId);
    const claimed = await claimOutboundOperations(w.db, { limit: 50 });
    const mine = claimed.find((o) => o.id === operationId);
    expect(mine).toBeDefined();
    await rt.voice.transferCall({
      organizationId: w.orgA.id,
      providerCallId,
      toNumber: "+15125550123",
      operationId,
    }); // ...then crash
    for (const other of claimed.filter((o) => o.id !== operationId)) {
      await w.pg.query(`update public.outbound_operations set status = 'pending' where id = $1`, [
        other.id,
      ]);
    }
    await w.pg.query(
      `update public.outbound_operations set lease_expires_at = now() - interval '1 second' where id = $1`,
      [operationId],
    );

    await dispatchOutboundOperations(w.db, rt); // must NOT pick it up again
    expect(rt.voice.transfers.filter((t) => t.providerCallId === providerCallId)).toHaveLength(1);
    await reconcileUnknownOperations(w.db, rt); // lease expiry -> unknown -> provider says forwarding
    expect(await opRow(operationId)).toMatchObject({ status: "succeeded" });
    expect(rt.voice.transfers.filter((t) => t.providerCallId === providerCallId)).toHaveLength(1);
  });
});

describe("SMS send reconciled by the delivery callback", () => {
  it("a send whose response was lost is settled by Twilio's status callback carrying the operation id", async () => {
    const rt = runtime();
    const { operation } = await runAs(w.db, owner(), (tx) =>
      requestOutboundSms(inTenant(tx, w.orgA.id), {
        fromNumber: BUSINESS_NUMBER,
        toNumber: CUSTOMER_NUMBER,
        body: "Crew is on the way",
        idempotencyKey: `sms-${randomUUID()}`,
      }),
    );
    rt.sms.scriptFailures({ kind: "ambiguous", performed: true });
    await dispatchOutboundOperations(w.db, rt);
    expect(await opRow(operation.id)).toMatchObject({ status: "unknown" });

    const sid = "SM" + "9".repeat(32);
    await deliver(
      w,
      twilio,
      twilioRequest(twilioStatusCallback("sent", { MessageSid: sid, SmsSid: sid }), {
        query: `?op=${operation.id}`,
      }),
    );
    await processWebhookEvents(w.db);
    expect(await opRow(operation.id)).toMatchObject({ status: "succeeded" });
    expect(rt.sms.sentMessages).toHaveLength(1);
    const msg = await w.pg.query<{ delivery_status: string }>(
      `select delivery_status from public.messages where provider_message_id = $1`,
      [sid],
    );
    expect(msg.rows[0]?.delivery_status).toBe("sent");

    // Out-of-order: "delivered" then a late "sent" leaves it delivered.
    await deliver(
      w,
      twilio,
      twilioRequest(twilioStatusCallback("delivered", { MessageSid: sid, SmsSid: sid }), {
        query: `?op=${operation.id}`,
      }),
    );
    await deliver(
      w,
      twilio,
      twilioRequest(twilioStatusCallback("queued", { MessageSid: sid, SmsSid: sid }), {
        query: `?op=${operation.id}`,
      }),
    );
    await processWebhookEvents(w.db);
    const final = await w.pg.query<{ delivery_status: string }>(
      `select delivery_status from public.messages where provider_message_id = $1`,
      [sid],
    );
    expect(final.rows[0]?.delivery_status).toBe("delivered");
  });

  it("a status callback that beats the message record is retried later, not dropped", async () => {
    const sid = "SM" + "7".repeat(32);
    const accepted = await deliver(
      w,
      twilio,
      twilioRequest(twilioStatusCallback("delivered", { MessageSid: sid, SmsSid: sid })),
    );
    await processWebhookEvents(w.db);
    const first = await w.pg.query<{ status: string }>(
      `select status from public.webhook_receipts where id = $1`,
      [accepted.event.id],
    );
    expect(first.rows[0]?.status).toBe("failed");

    await w.pg.query(
      `with c as (insert into public.communications (organization_id, channel, direction, status, provider, provider_conversation_id)
                  values ($1, 'sms', 'outbound', 'completed', 'twilio', $2) returning id)
       insert into public.messages (organization_id, communication_id, provider_message_id) select $1, id, $2 from c`,
      [w.orgA.id, sid],
    );
    await makeEverythingDue(w);
    await processWebhookEvents(w.db);
    const later = await w.pg.query<{ delivery_status: string }>(
      `select delivery_status from public.messages where provider_message_id = $1`,
      [sid],
    );
    expect(later.rows[0]?.delivery_status).toBe("delivered");
  });
});
