// M2-T19: the receptionist runtime answers Vapi's synchronous assistant-request in-process, from the
// tenant's provider_routes and receptionist configuration, with a safe fallback for an unknown
// number or a tenant with no active configuration.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECEPTIONIST_CONFIG_RULE_ACTION } from "@backoffice/domain";
import { resolveAssistantTurn } from "../src";
import { BUSINESS_NUMBER, count, createWorld, setupRoutes, type World } from "./helpers";

let w: World;
const UNKNOWN_NUMBER = "+15125559999";

beforeAll(async () => {
  w = await createWorld();
  await setupRoutes(w);
});
afterAll(async () => {
  await w.close();
});

const resolve = (routingAddress: string | null) =>
  resolveAssistantTurn(w.db, { provider: "vapi", routingAddress });

describe("resolveAssistantTurn", () => {
  it("falls back for an unknown number: no tools, no business identity, no ops case", async () => {
    const turn = await resolve(UNKNOWN_NUMBER);
    expect(turn.tools).toEqual([]);
    expect(turn.firstMessage).not.toContain("Org A");
    expect(
      await count(w.pg, `select 1 from public.ops_cases where organization_id = $1`, [w.orgA.id]),
    ).toBe(0);
  });

  it("falls back and opens an ops case when the tenant has no active receptionist configuration", async () => {
    const turn = await resolve(BUSINESS_NUMBER);
    expect(turn.tools).toEqual([]);
    expect(
      await count(
        w.pg,
        `select 1 from public.ops_cases where organization_id = $1 and reason_code = 'missing_data'`,
        [w.orgA.id],
      ),
    ).toBe(1);
  });

  it("builds a valid assistant turn from the tenant's prompt, hours and bounded tool set once configured", async () => {
    await w.pg.query(
      `insert into public.business_rules (organization_id, action, rule_key, definition)
       values ($1, $2, 'default', $3::jsonb)`,
      [
        w.orgA.id,
        RECEPTIONIST_CONFIG_RULE_ACTION,
        JSON.stringify({ business_hours: "Mon-Fri 8am-5pm" }),
      ],
    );
    const turn = await resolve(BUSINESS_NUMBER);
    expect(turn.firstMessage).toContain("Org A");
    expect(turn.systemPrompt).toContain("Org A");
    expect(turn.systemPrompt).toContain("Mon-Fri 8am-5pm");
    expect(turn.systemPrompt).not.toMatch(/you (may|can) approve/i);
    expect(turn.tools.map((t) => t.name).sort()).toEqual(
      ["create_callback_task", "create_lead", "lookup_business_info", "request_transfer"].sort(),
    );
    const lookupTool = turn.tools.find((t) => t.name === "lookup_business_info");
    expect(lookupTool?.parameters).toMatchObject({ type: "object" });
  });
});
