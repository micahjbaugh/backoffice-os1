import "server-only";

import { NextResponse } from "next/server";
import { recordWebhookReceipt, runAs } from "@backoffice/core";
import type { Actor } from "@backoffice/domain";
import { db } from "./db";

interface ProviderWebhookAdapter {
  verifyWebhookSignature(rawBody: string, headers: { get(name: string): string | null }): boolean;
  ingestWebhook(
    rawEvent: unknown,
  ): Promise<{ provider: string; providerEventId: string; payload: unknown }>;
}

/**
 * Shared inbound webhook flow for every provider: verify the signature via the adapter, then
 * record the receipt before any further processing runs. Never trusts a tenant id carried in the
 * payload (docs/ARCHITECTURE.md M2 sequence, step 3) — that resolution happens in a later task.
 */
export async function handleProviderWebhook(
  adapter: ProviderWebhookAdapter,
  request: Request,
): Promise<Response> {
  const rawBody = await request.text();
  if (!adapter.verifyWebhookSignature(rawBody, request.headers)) {
    console.warn("webhook signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const event = await adapter.ingestWebhook(parsed);
  const actor: Actor = { type: "integration", name: `${event.provider}-webhook` };
  await runAs(db(), actor, (tx) =>
    recordWebhookReceipt(tx, { provider: event.provider, providerEventId: event.providerEventId }),
  );
  return NextResponse.json({ ok: true });
}
