// Owner-only phone number management (M2-T18): register/deactivate, tenant isolation, and
// re-queuing webhook events that arrived before the number was registered.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import {
  acceptWebhookEvent,
  deactivateProviderRoute,
  listProviderRoutes,
  registerProviderRoute,
  type AcceptWebhookInput,
} from "../src";
import { asTx, count, inOrg, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const integration: Actor = { type: "integration", name: "twilio-webhook" };
const UNROUTED_NUMBER = "+15125559100";

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

describe("registerProviderRoute", () => {
  it("only the owner can register a route", async () => {
    for (const userId of [
      w.orgA.officeAdmin,
      w.orgA.manager,
      w.orgA.fieldEmployee,
      w.orgA.accountant,
    ]) {
      await expect(
        inOrg(w.db, userActor(userId), w.orgA.id, (ctx) =>
          registerProviderRoute(ctx, {
            provider: "twilio",
            channel: "sms",
            address: UNROUTED_NUMBER,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("normalizes the phone number and re-queues unroutable events for it", async () => {
    const accepted = await asTx(w.db, integration, (tx) =>
      acceptWebhookEvent(tx, {
        provider: "twilio",
        channel: "sms",
        eventType: "sms.inbound",
        eventKey: "SMpre:inbound",
        resourceId: "SMpre",
        deliveryId: null,
        occurredAt: null,
        routingAddress: UNROUTED_NUMBER,
        payload: { body: "hi" },
        rawBody: "raw-body",
      } satisfies AcceptWebhookInput),
    );
    expect(accepted.event.status).toBe("unroutable");

    const { route, requeuedEvents } = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      registerProviderRoute(ctx, {
        provider: "twilio",
        channel: "sms",
        // Same number as UNROUTED_NUMBER, typed differently; normalization must still match it.
        address: "(512) 555-9100",
      }),
    );
    expect(route).toMatchObject({
      organizationId: w.orgA.id,
      provider: "twilio",
      channel: "sms",
      address: UNROUTED_NUMBER,
      active: true,
    });
    expect(requeuedEvents).toBe(1);

    const { rows } = await w.pg.query<{ status: string; organization_id: string }>(
      `select status, organization_id from public.webhook_receipts where provider_event_id = 'SMpre:inbound'`,
    );
    expect(rows[0]).toMatchObject({ status: "received", organization_id: w.orgA.id });
  });

  it("rejects a channel that does not match the provider's adapter", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        registerProviderRoute(ctx, {
          provider: "twilio",
          channel: "voice",
          address: "+15125559200",
        }),
      ),
    ).rejects.toThrow(/channel/);
  });

  it("cannot register the same active number for another tenant", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) =>
        registerProviderRoute(ctx, {
          provider: "twilio",
          channel: "sms",
          address: UNROUTED_NUMBER,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("deactivateProviderRoute", () => {
  it("owner can deactivate; other roles and other tenants cannot", async () => {
    const { route } = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      registerProviderRoute(ctx, { provider: "vapi", channel: "voice", address: "+15125559300" }),
    );

    await expect(
      inOrg(w.db, userActor(w.orgA.manager), w.orgA.id, (ctx) =>
        deactivateProviderRoute(ctx, route.id),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) =>
        deactivateProviderRoute(ctx, route.id),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      deactivateProviderRoute(ctx, route.id),
    );
    const routes = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      listProviderRoutes(ctx),
    );
    expect(routes.find((r) => r.id === route.id)?.active).toBe(false);

    // Already inactive: a second deactivation finds nothing to change.
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        deactivateProviderRoute(ctx, route.id),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("registrations and deactivations are audited by the provider_routes trigger", async () => {
    const created = await count(
      w.pg,
      `select 1 from public.audit_log where action = 'provider_route.created' and organization_id = $1`,
      [w.orgA.id],
    );
    const updated = await count(
      w.pg,
      `select 1 from public.audit_log where action = 'provider_route.updated' and organization_id = $1`,
      [w.orgA.id],
    );
    expect(created).toBeGreaterThanOrEqual(2);
    expect(updated).toBeGreaterThanOrEqual(1);
  });
});
