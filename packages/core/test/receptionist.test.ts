// M2-T19: resolving the tenant + receptionist configuration for a synchronous Vapi assistant-request.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, RECEPTIONIST_CONFIG_RULE_ACTION, type Actor } from "@backoffice/domain";
import { lookupBusinessInfo, resolveReceptionistConfig } from "../src";
import { asTx, count, inOrg, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const RUNTIME: Actor = { type: "system", name: "receptionist-runtime-test" };
const RECEPTIONIST: Actor = { type: "agent", name: "receptionist-test" };
const BUSINESS_NUMBER = "+15125550100";
const UNKNOWN_NUMBER = "+15125559999";

beforeAll(async () => {
  w = await createWorld();
  await w.pg.query(
    `insert into public.provider_routes (organization_id, provider, channel, address)
     values ($1, 'vapi', 'voice', $2)`,
    [w.orgA.id, BUSINESS_NUMBER],
  );
});
afterAll(async () => {
  await w.close();
});

const resolve = (routingAddress: string | null) =>
  asTx(w.db, RUNTIME, (tx) => resolveReceptionistConfig(tx, { provider: "vapi", routingAddress }));

describe("resolveReceptionistConfig", () => {
  it("has no tenant to escalate to for a number with no provider route", async () => {
    expect(await resolve(UNKNOWN_NUMBER)).toEqual({ status: "unknown_number" });
    expect(
      await count(w.pg, `select 1 from public.ops_cases where organization_id = $1`, [w.orgA.id]),
    ).toBe(0);
  });

  it("falls back and opens a high-priority ops case when the tenant has no active config", async () => {
    expect(await resolve(BUSINESS_NUMBER)).toEqual({
      status: "missing_config",
      organizationId: w.orgA.id,
    });
    expect(
      await count(
        w.pg,
        `select 1 from public.ops_cases
          where organization_id = $1 and reason_code = 'missing_data' and priority = 'high'`,
        [w.orgA.id],
      ),
    ).toBe(1);
  });

  it("resolves the business name and hours once an active receptionist.config rule exists", async () => {
    await w.pg.query(
      `insert into public.business_rules (organization_id, action, rule_key, definition)
       values ($1, $2, 'default', $3::jsonb)`,
      [
        w.orgA.id,
        RECEPTIONIST_CONFIG_RULE_ACTION,
        JSON.stringify({ business_hours: "Mon-Fri 8am-5pm" }),
      ],
    );
    expect(await resolve(BUSINESS_NUMBER)).toEqual({
      status: "resolved",
      organizationId: w.orgA.id,
      businessName: "Org A",
      businessHours: "Mon-Fri 8am-5pm",
    });
  });
});

describe("lookupBusinessInfo", () => {
  const lookup = (topic: "hours" | "services" | "service_area" | "address") =>
    inOrg(w.db, RECEPTIONIST, w.orgA.id, (ctx) => lookupBusinessInfo(ctx, topic));

  it("returns only the tenant's own configured, caller-safe field for a known topic", async () => {
    expect(await lookup("hours")).toBe("Mon-Fri 8am-5pm");
  });

  it("never invents a value for a topic the owner hasn't configured", async () => {
    expect(await lookup("address")).toBeNull();
  });

  it("denies actors without receptionist.lookup, e.g. a regular staff user", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.manager), w.orgA.id, (ctx) => lookupBusinessInfo(ctx, "hours")),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("resolveReceptionistConfig: disabled rule", () => {
  it("ignores a disabled rule and falls back again", async () => {
    await w.pg.query(
      `update public.business_rules set enabled = false
        where organization_id = $1 and action = $2`,
      [w.orgA.id, RECEPTIONIST_CONFIG_RULE_ACTION],
    );
    expect(await resolve(BUSINESS_NUMBER)).toMatchObject({ status: "missing_config" });
  });
});
