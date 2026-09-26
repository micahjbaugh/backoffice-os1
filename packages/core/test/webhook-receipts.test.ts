// M2-T06: idempotent webhook receipt tracking. webhook_receipts has RLS enabled with no policies
// and all privileges revoked from `authenticated` (0001/0002), so it is never client-readable or
// writable — only server-internal code (asService) can touch it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, type Actor } from "@backoffice/domain";
import { getWebhookReceipt, recordWebhookReceipt, updateWebhookReceiptStatus } from "../src";
import { asTx, count, rawAsUser } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const system: Actor = { type: "integration", name: "voice-webhook-test" };

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

describe("recordWebhookReceipt", () => {
  it("inserts a new receipt and reports it as non-duplicate", async () => {
    const { receipt, duplicate } = await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, { provider: "vapi", providerEventId: "evt-1" }),
    );
    expect(duplicate).toBe(false);
    expect(receipt.provider).toBe("vapi");
    expect(receipt.providerEventId).toBe("evt-1");
    expect(receipt.status).toBe("received");
    expect(receipt.processedAt).toBeNull();
  });

  it("a duplicate (provider, provider_event_id) returns the existing row instead of inserting", async () => {
    const first = await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, { provider: "vapi", providerEventId: "evt-dup" }),
    );
    const second = await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, {
        provider: "vapi",
        providerEventId: "evt-dup",
        payloadHash: "different-hash-ignored",
      }),
    );
    expect(second.duplicate).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(second.receipt.payloadHash).toBe(first.receipt.payloadHash);

    const rows = await count(
      w.pg,
      `select 1 from public.webhook_receipts where provider = 'vapi' and provider_event_id = 'evt-dup'`,
    );
    expect(rows).toBe(1);
  });

  it("distinguishes events with the same id across different providers", async () => {
    const vapi = await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, { provider: "vapi", providerEventId: "evt-shared" }),
    );
    const twilio = await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, { provider: "twilio", providerEventId: "evt-shared" }),
    );
    expect(vapi.receipt.id).not.toBe(twilio.receipt.id);
    expect(vapi.duplicate).toBe(false);
    expect(twilio.duplicate).toBe(false);
  });

  it("associates a receipt with an organization when one is already known", async () => {
    const { receipt } = await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, {
        provider: "twilio",
        providerEventId: "evt-org",
        organizationId: w.orgA.id,
      }),
    );
    expect(receipt.organizationId).toBe(w.orgA.id);
  });
});

describe("updateWebhookReceiptStatus", () => {
  it("updates status and stamps processed_at once it leaves 'received'", async () => {
    const { receipt } = await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, { provider: "vapi", providerEventId: "evt-status" }),
    );
    expect(receipt.processedAt).toBeNull();

    const processed = await asTx(w.db, system, (tx) =>
      updateWebhookReceiptStatus(tx, receipt.id, "processed"),
    );
    expect(processed.status).toBe("processed");
    expect(processed.processedAt).not.toBeNull();
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(
      asTx(w.db, system, (tx) =>
        updateWebhookReceiptStatus(tx, "00000000-0000-0000-0000-000000000000", "failed"),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getWebhookReceipt", () => {
  it("returns null when no receipt matches", async () => {
    const result = await asTx(w.db, system, (tx) => getWebhookReceipt(tx, "vapi", "evt-missing"));
    expect(result).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("no client role can read or write webhook_receipts directly", async () => {
    await asTx(w.db, system, (tx) =>
      recordWebhookReceipt(tx, { provider: "vapi", providerEventId: "evt-rls" }),
    );

    await expect(
      rawAsUser(w.pg, w.orgA.owner, `select * from public.webhook_receipts`),
    ).rejects.toThrow();
    await expect(
      rawAsUser(w.pg, null, `select * from public.webhook_receipts`),
    ).rejects.toThrow();
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.webhook_receipts (provider, provider_event_id) values ('vapi', 'evt-forged')`,
      ),
    ).rejects.toThrow();
  });
});
