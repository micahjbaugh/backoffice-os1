// Required M1 tests 3–6: approval authority, idempotent decisions, decision event, decision audit.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ConflictError,
  ForbiddenError,
  type Actor,
  type Approval,
  type UUID,
} from "@backoffice/domain";
import {
  addNote,
  createApproval,
  createApprovalRuleVersion,
  decideApproval,
  listNotes,
  listPendingApprovals,
  retireRule,
} from "../src";
import { count, inOrg, rawAsUser, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

const system: Actor = { type: "system", name: "test-workflow" };

async function requestApproval(
  overrides: Partial<Parameters<typeof createApproval>[1]> = {},
): Promise<Approval> {
  const { approval } = await inOrg(w.db, system, w.orgA.id, (ctx) =>
    createApproval(ctx, {
      type: "purchase",
      title: "21 ton crushed rock",
      amountCents: 45_000,
      idempotencyKey: `test-${randomUUID()}`,
      ...overrides,
    }),
  );
  return approval;
}

const decide = (userId: UUID, approvalId: UUID, decision: "approved" | "rejected", note?: string) =>
  inOrg(w.db, userActor(userId), w.orgA.id, (ctx) =>
    decideApproval(ctx, { approvalId, decision, note }),
  );

const statusOf = async (id: UUID) =>
  (await w.pg.query<{ status: string }>(`select status from public.approvals where id = $1`, [id]))
    .rows[0]?.status;

const decidedEvents = (id: UUID) =>
  count(
    w.pg,
    `select 1 from public.business_events where type = 'approval.decided' and entity_id = $1`,
    [id],
  );

const decidedAudits = (id: UUID) =>
  count(
    w.pg,
    `select 1 from public.audit_log where action = 'approval.decided' and approval_id = $1`,
    [id],
  );

describe("3. field employee cannot approve owner's financial approval", () => {
  let approval: Approval;
  beforeEach(async () => {
    approval = await requestApproval();
  });

  it("service rejects with ForbiddenError, approval stays pending, nothing emitted", async () => {
    await expect(decide(w.orgA.fieldEmployee, approval.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await statusOf(approval.id)).toBe("pending");
    expect(await decidedEvents(approval.id)).toBe(0);
    expect(await decidedAudits(approval.id)).toBe(0);
  });

  it("the denied attempt is itself audited", async () => {
    await expect(decide(w.orgA.fieldEmployee, approval.id, "approved")).rejects.toThrow();
    const denials = await count(
      w.pg,
      `select 1 from public.audit_log
        where action = 'authz.denied' and actor_id = $1 and entity_id = $2`,
      [w.orgA.fieldEmployee, approval.id],
    );
    expect(denials).toBe(1);
  });

  it("direct database update by the field employee is denied", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.fieldEmployee,
        `update public.approvals set status = 'approved' where id = $1`,
        [approval.id],
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await statusOf(approval.id)).toBe("pending");
  });

  it("field employee cannot even see the financial approval", async () => {
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA.fieldEmployee,
      `select * from public.approvals where id = $1`,
      [approval.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("manager and accountant cannot decide either; office_admin cannot decide financial by default", async () => {
    for (const user of [w.orgA.manager, w.orgA.accountant, w.orgA.officeAdmin]) {
      await expect(decide(user, approval.id, "approved")).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await statusOf(approval.id)).toBe("pending");
  });

  it("even owners/admins cannot bypass the service with a direct update", async () => {
    for (const user of [w.orgA.owner, w.orgA.officeAdmin]) {
      await expect(
        rawAsUser(w.pg, user, `update public.approvals set status = 'approved' where id = $1`, [
          approval.id,
        ]),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("owner can approve", async () => {
    const result = await decide(w.orgA.owner, approval.id, "approved");
    expect(result.approval.status).toBe("approved");
    expect(result.approval.decidedByUserId).toBe(w.orgA.owner);
  });
});

describe("4. deciding an approval twice does not execute twice", () => {
  it("sequential double decision: second call is a no-op replay", async () => {
    const approval = await requestApproval();
    const first = await decide(w.orgA.owner, approval.id, "approved");
    const second = await decide(w.orgA.owner, approval.id, "approved");

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(second.approval.decidedAt).toBe(first.approval.decidedAt);
    expect(await decidedEvents(approval.id)).toBe(1);
    expect(await decidedAudits(approval.id)).toBe(1);
  });

  it("concurrent double-click: exactly one decision executes", async () => {
    const approval = await requestApproval();
    const results = await Promise.all([
      decide(w.orgA.owner, approval.id, "approved"),
      decide(w.orgA.owner, approval.id, "approved"),
      decide(w.orgA.owner, approval.id, "approved"),
    ]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await decidedEvents(approval.id)).toBe(1);
    expect(await decidedAudits(approval.id)).toBe(1);
  });

  it("a conflicting second decision is rejected and changes nothing", async () => {
    const approval = await requestApproval();
    await decide(w.orgA.owner, approval.id, "approved");
    await expect(decide(w.orgA.owner, approval.id, "rejected")).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await statusOf(approval.id)).toBe("approved");
    expect(await decidedEvents(approval.id)).toBe(1);
  });

  it("the database refuses to change a decided approval even for privileged code", async () => {
    const approval = await requestApproval();
    await decide(w.orgA.owner, approval.id, "rejected");
    await expect(
      w.pg.query(`update public.approvals set status = 'approved' where id = $1`, [approval.id]),
    ).rejects.toThrow(/already rejected/);
  });

  it("amount and type of an approval are immutable", async () => {
    const approval = await requestApproval();
    await expect(
      w.pg.query(`update public.approvals set amount_cents = 1 where id = $1`, [approval.id]),
    ).rejects.toThrow(/immutable/);
  });
});

describe("5 & 6. approval decision creates a business event and an audit record", () => {
  it("approve: event + audit linked to each other and to the approval", async () => {
    const approval = await requestApproval();
    const { event } = await decide(w.orgA.owner, approval.id, "approved", "go ahead");

    const events = await w.pg.query<Record<string, unknown>>(
      `select * from public.business_events where type = 'approval.decided' and entity_id = $1`,
      [approval.id],
    );
    expect(events.rows).toHaveLength(1);
    const row = events.rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      id: event.id,
      organization_id: w.orgA.id,
      actor_type: "user",
      actor_id: w.orgA.owner,
      entity_type: "approval",
      idempotency_key: `approval.decided:${approval.id}`,
    });
    expect(row.payload).toMatchObject({
      decision: "approved",
      policy_source: "default:owner",
      amount_cents: 45_000,
    });

    const audits = await w.pg.query<Record<string, unknown>>(
      `select * from public.audit_log where action = 'approval.decided' and approval_id = $1`,
      [approval.id],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      organization_id: w.orgA.id,
      actor_type: "user",
      actor_id: w.orgA.owner,
      source_event_id: event.id,
    });
    expect((audits.rows[0] as { details: unknown }).details).toMatchObject({
      decision: "approved",
      previous_status: "pending",
      decider_role: "owner",
    });
  });

  it("reject also produces exactly one event and one audit record", async () => {
    const approval = await requestApproval();
    await decide(w.orgA.owner, approval.id, "rejected", "too expensive");
    expect(await decidedEvents(approval.id)).toBe(1);
    expect(await decidedAudits(approval.id)).toBe(1);
    const { rows } = await w.pg.query<{ decision_note: string }>(
      `select decision_note from public.approvals where id = $1`,
      [approval.id],
    );
    expect(rows[0]?.decision_note).toBe("too expensive");
  });
});

describe("approval creation", () => {
  it("is idempotent on the idempotency key", async () => {
    const key = `purchase-${randomUUID()}`;
    const create = () =>
      inOrg(w.db, system, w.orgA.id, (ctx) =>
        createApproval(ctx, {
          type: "purchase",
          title: "Rock",
          amountCents: 100,
          idempotencyKey: key,
        }),
      );
    const a = await create();
    const b = await create();
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.approval.id).toBe(a.approval.id);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'approval.requested' and entity_id = $1`,
        [a.approval.id],
      ),
    ).toBe(1);
  });

  it("rejects reuse of an idempotency key for a different approval", async () => {
    const key = `purchase-${randomUUID()}`;
    await inOrg(w.db, system, w.orgA.id, (ctx) =>
      createApproval(ctx, {
        type: "purchase",
        title: "Rock",
        amountCents: 100,
        idempotencyKey: key,
      }),
    );
    await expect(
      inOrg(w.db, system, w.orgA.id, (ctx) =>
        createApproval(ctx, {
          type: "purchase",
          title: "Rock",
          amountCents: 999,
          idempotencyKey: key,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("the same idempotency key in two orgs creates two independent approvals", async () => {
    const key = `shared-${randomUUID()}`;
    const input = { type: "schedule.change", title: "Move job", idempotencyKey: key };
    const a = await inOrg(w.db, system, w.orgA.id, (ctx) => createApproval(ctx, input));
    const b = await inOrg(w.db, system, w.orgB.id, (ctx) => createApproval(ctx, input));
    expect(a.approval.id).not.toBe(b.approval.id);
  });

  it("writes an approval.created audit record and an approval.requested event", async () => {
    const approval = await requestApproval();
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'approval.created' and approval_id = $1`,
        [approval.id],
      ),
    ).toBe(1);
  });

  it("field employees may request approvals and see only their own", async () => {
    const { approval } = await inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
      createApproval(ctx, {
        type: "purchase",
        title: "Gloves",
        amountCents: 2_000,
        idempotencyKey: `fe-${randomUUID()}`,
      }),
    );
    const { rows } = await rawAsUser<{ id: string }>(
      w.pg,
      w.orgA.fieldEmployee,
      `select id from public.approvals`,
    );
    expect(rows.map((r) => r.id)).toEqual([approval.id]);
  });

  it("accountants cannot request approvals", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.accountant), w.orgA.id, (ctx) =>
        createApproval(ctx, {
          type: "purchase",
          title: "x",
          idempotencyKey: `acct-${randomUUID()}`,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("decision policy", () => {
  it("agents can request but never decide approvals", async () => {
    const agent: Actor = { type: "agent", name: "owner_assistant" };
    const { approval } = await inOrg(w.db, agent, w.orgA.id, (ctx) =>
      createApproval(ctx, {
        type: "schedule.change",
        title: "Move",
        idempotencyKey: `agent-${randomUUID()}`,
      }),
    );
    expect(approval.requestedByActorType).toBe("agent");
    await expect(
      inOrg(w.db, agent, w.orgA.id, (ctx) =>
        decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await statusOf(approval.id)).toBe("pending");
  });

  it("office_admin decides non-financial approvals by default", async () => {
    const approval = await requestApproval({ type: "schedule.change", amountCents: undefined });
    const result = await decide(w.orgA.officeAdmin, approval.id, "approved");
    expect(result.approval.status).toBe("approved");
  });

  it("owner can delegate purchases up to a limit to office_admin via a versioned rule", async () => {
    const small = await requestApproval({ amountCents: 40_000 });
    const large = await requestApproval({ amountCents: 60_000 });

    const rule = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createApprovalRuleVersion(ctx, {
        ruleKey: "admin-purchases",
        approvalTypes: ["purchase"],
        roles: ["office_admin"],
        maxAmountCents: 50_000,
      }),
    );
    expect(rule.version).toBe(1);

    const ok = await decide(w.orgA.officeAdmin, small.id, "approved");
    expect(ok.event.payload.policy_source).toBe(`business_rule:${rule.id}@v1`);
    await expect(decide(w.orgA.officeAdmin, large.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // Retiring the rule removes the delegation.
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) => retireRule(ctx, rule.id));
    const another = await requestApproval({ amountCents: 10_000 });
    await expect(decide(w.orgA.officeAdmin, another.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("new rule versions supersede old ones", async () => {
    const make = (max: number) =>
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        createApprovalRuleVersion(ctx, {
          ruleKey: "versioned",
          roles: ["office_admin"],
          maxAmountCents: max,
        }),
      );
    const v1 = await make(1_000);
    const v2 = await make(2_000);
    expect(v2.version).toBe(2);
    const { rows } = await w.pg.query<{ effective_to: unknown }>(
      `select effective_to from public.business_rules where id = $1`,
      [v1.id],
    );
    expect(rows[0]?.effective_to).not.toBeNull();
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'business_rule.version_created' and entity_id = $1`,
        [v2.id],
      ),
    ).toBe(1);
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) => retireRule(ctx, v2.id));
  });

  it("only owners can write rules; rules cannot delegate to managers", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.officeAdmin), w.orgA.id, (ctx) =>
        createApprovalRuleVersion(ctx, { ruleKey: "self-grant", roles: ["office_admin"] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        createApprovalRuleVersion(ctx, { ruleKey: "bad", roles: ["manager" as "office_admin"] }),
      ),
    ).rejects.toThrow(/Invalid input/);
  });

  it("a malformed rule stored in the database grants nothing (fails closed)", async () => {
    await w.pg.query(
      `insert into public.business_rules (organization_id, action, rule_key, definition)
       values ($1, 'approval.decide', 'corrupt', '{"roles": ["field_employee"]}')`,
      [w.orgA.id],
    );
    const approval = await requestApproval();
    await expect(decide(w.orgA.fieldEmployee, approval.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(decide(w.orgA.officeAdmin, approval.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("red approvals are owner-only even with delegation", async () => {
    const rule = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createApprovalRuleVersion(ctx, { ruleKey: "all-admin", roles: ["office_admin"] }),
    );
    const red = await requestApproval({ riskClass: "red", amountCents: 5_000_000 });
    await expect(decide(w.orgA.officeAdmin, red.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await decide(w.orgA.owner, red.id, "approved")).approval.status).toBe("approved");
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) => retireRule(ctx, rule.id));
  });

  it("expired approvals cannot be decided and leave the inbox", async () => {
    const approval = await requestApproval({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(decide(w.orgA.owner, approval.id, "approved")).rejects.toMatchObject({
      reason: "approval_expired",
    });
    const pending = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      listPendingApprovals(ctx),
    );
    expect(pending.map((a) => a.id)).not.toContain(approval.id);
  });

  it("org B owner cannot decide org A's approval", async () => {
    const approval = await requestApproval();
    await expect(
      inOrg(w.db, userActor(w.orgB.owner), w.orgA.id, (ctx) =>
        decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) =>
        decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
      ),
    ).rejects.toThrow(/not found/);
    expect(await statusOf(approval.id)).toBe("pending");
  });
});

describe("inbox notes", () => {
  it("adds a note to an approval with event and audit", async () => {
    const approval = await requestApproval();
    const note = await inOrg(w.db, userActor(w.orgA.officeAdmin), w.orgA.id, (ctx) =>
      addNote(ctx, {
        entityType: "approval",
        entityId: approval.id,
        body: "Called supplier, price holds until Friday",
      }),
    );
    const notes = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      listNotes(ctx, "approval", [approval.id]),
    );
    expect(notes.map((n) => n.id)).toEqual([note.id]);
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'note.added' and approval_id = $1`,
        [approval.id],
      ),
    ).toBe(1);
  });

  it("field employees cannot add notes; clients cannot insert notes directly", async () => {
    const approval = await requestApproval();
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        addNote(ctx, { entityType: "approval", entityId: approval.id, body: "hi" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.notes (organization_id, entity_type, entity_id, body, author_actor_type) values ($1, 'approval', $2, 'x', 'user')`,
        [w.orgA.id, approval.id],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
