// M2-T19: the receptionist runtime answers Vapi's synchronous assistant-request in-process, from the
// tenant's provider_routes and receptionist configuration, with a safe fallback for an unknown
// number or a tenant with no active configuration.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECEPTIONIST_CONFIG_RULE_ACTION } from "@backoffice/domain";
import {
  executeReceptionistToolCalls,
  resolveAssistantTurn,
  resolveTransferDestination,
} from "../src";
import {
  BUSINESS_NUMBER,
  count,
  createWorld,
  CUSTOMER_NUMBER,
  setupRoutes,
  type World,
} from "./helpers";

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

describe("executeReceptionistToolCalls", () => {
  beforeAll(async () => {
    // Supersedes the hours-only config from the previous describe block (higher version wins):
    // "services" is configured and caller-safe; "address" is deliberately left unset.
    await w.pg.query(
      `insert into public.business_rules (organization_id, action, rule_key, version, definition)
       values ($1, $2, 'default', 2, $3::jsonb)`,
      [
        w.orgA.id,
        RECEPTIONIST_CONFIG_RULE_ACTION,
        JSON.stringify({
          business_hours: "Mon-Fri 8am-5pm",
          services: "Plumbing repair and installation",
        }),
      ],
    );
  });

  const execute = (callId: string, toolCalls: { id: string; name: string; arguments: unknown }[]) =>
    executeReceptionistToolCalls(w.db, {
      provider: "vapi",
      routingAddress: BUSINESS_NUMBER,
      callId,
      customerNumber: CUSTOMER_NUMBER,
      businessNumber: BUSINESS_NUMBER,
      toolCalls,
    });

  it("looks up only permitted, tenant-configured info and never invents an unconfigured field", async () => {
    const results = await execute(`call-${randomUUID()}`, [
      { id: `tc-${randomUUID()}`, name: "lookup_business_info", arguments: { topic: "services" } },
      { id: `tc-${randomUUID()}`, name: "lookup_business_info", arguments: { topic: "address" } },
    ]);
    expect(results[0]?.result).toBe("Plumbing repair and installation");
    expect(results[1]?.result).not.toContain("Plumbing");
    expect(results[1]?.result).toMatch(/don't have that information/i);
  });

  it("creates exactly one lead and one callback task per tool call id, even when the webhook is redelivered", async () => {
    const callId = `call-${randomUUID()}`;
    const leadCallId = `tc-lead-${randomUUID()}`;
    const taskCallId = `tc-task-${randomUUID()}`;
    const toolCalls = [
      {
        id: leadCallId,
        name: "create_lead",
        arguments: { source: "voice", firstName: "Jane", phone: "+15551234567" },
      },
      { id: taskCallId, name: "create_callback_task", arguments: { title: "Call Jane back" } },
    ];

    const first = await execute(callId, toolCalls);
    const second = await execute(callId, toolCalls); // simulated redelivery of the same webhook

    expect(second).toEqual(first);
    expect(
      await count(
        w.pg,
        `select 1 from public.leads where organization_id = $1 and idempotency_key = $2`,
        [w.orgA.id, `vapi:tool_call:${leadCallId}`],
      ),
    ).toBe(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.tasks where organization_id = $1 and idempotency_key = $2`,
        [w.orgA.id, `vapi:tool_call:${taskCallId}`],
      ),
    ).toBe(1);
  });

  it("audits the agent actor's mutations exactly once even when redelivered", async () => {
    const callId = `call-${randomUUID()}`;
    const taskCallId = `tc-task-${randomUUID()}`;
    const toolCalls = [
      { id: taskCallId, name: "create_callback_task", arguments: { title: "Call back" } },
    ];
    await execute(callId, toolCalls);
    await execute(callId, toolCalls);

    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log al
          join public.tasks t on t.id = al.entity_id
          where al.action = 'task.created' and al.actor_type = 'agent'
            and t.organization_id = $1 and t.idempotency_key = $2`,
        [w.orgA.id, `vapi:tool_call:${taskCallId}`],
      ),
    ).toBe(1);
  });
});

describe("resolveTransferDestination", () => {
  const resolveTransfer = (callId: string, routingAddress: string | null = BUSINESS_NUMBER) =>
    resolveTransferDestination(w.db, {
      provider: "vapi",
      routingAddress,
      callId,
      customerNumber: CUSTOMER_NUMBER,
      businessNumber: BUSINESS_NUMBER,
    });

  it("returns null for an unknown number", async () => {
    expect(await resolveTransfer(`call-${randomUUID()}`, UNKNOWN_NUMBER)).toBeNull();
  });

  it("returns null and escalates when the active config has no on-call employee", async () => {
    // Org A's active receptionist.config (set up above) has no transfer_employee_id yet.
    expect(await resolveTransfer(`call-${randomUUID()}`)).toBeNull();
    expect(
      await count(
        w.pg,
        `select 1 from public.ops_cases where organization_id = $1 and reason_code = 'missing_data'
          and title like 'Caller needs a warm transfer%'`,
        [w.orgA.id],
      ),
    ).toBe(1);
  });

  it("returns the on-call employee's number once configured, recording the request once even redelivered", async () => {
    const employee = await w.pg.query<{ id: string }>(
      `insert into public.employees (organization_id, display_name, phone) values ($1, 'On-call Tech', $2) returning id`,
      [w.orgA.id, "+15005550088"],
    );
    const onCallId = employee.rows[0]?.id;
    await w.pg.query(
      `insert into public.business_rules (organization_id, action, rule_key, version, definition)
       values ($1, $2, 'default', 3, $3::jsonb)`,
      [
        w.orgA.id,
        RECEPTIONIST_CONFIG_RULE_ACTION,
        JSON.stringify({
          business_hours: "Mon-Fri 8am-5pm",
          services: "Plumbing repair and installation",
          transfer_employee_id: onCallId,
        }),
      ],
    );

    const callId = `call-${randomUUID()}`;
    const first = await resolveTransfer(callId);
    const second = await resolveTransfer(callId); // simulated redelivery of the same webhook
    expect(first).toEqual({ type: "number", number: "+15005550088" });
    expect(second).toEqual(first);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events
          where type = 'communication.transfer_requested' and payload->>'to_employee_id' = $1`,
        [onCallId],
      ),
    ).toBe(1);
  });
});
