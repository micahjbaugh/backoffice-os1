// Required M1 test 8: an internal operator cannot access a tenant without a scoped grant.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, type Actor, type OpsCase } from "@backoffice/domain";
import {
  createOpsCase,
  grantOperatorAccess,
  listOperatorCases,
  listOperatorGrants,
  listOrgOpsCases,
  openOpsCase,
  revokeOperatorAccess,
  updateOpsCaseAsOperator,
} from "../src";
import { asTx, count, createUser, inOrg, operatorActor, rawAsUser, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
let caseA: OpsCase;
let caseB: OpsCase;
const workflow: Actor = { type: "system", name: "extraction-workflow" };

beforeAll(async () => {
  w = await createWorld();
  caseA = await inOrg(w.db, workflow, w.orgA.id, (ctx) =>
    createOpsCase(ctx, {
      title: "Crew text could not be matched to a job",
      reasonCode: "low_confidence",
      priority: "high",
      entityType: "job",
      entityId: w.orgA.job.id,
      evidence: { message_excerpt: "hoe 8 hrs wilson" },
    }),
  );
  caseB = await inOrg(w.db, workflow, w.orgB.id, (ctx) =>
    createOpsCase(ctx, { title: "Vendor dispute", reasonCode: "external_dispute" }),
  );
});
afterAll(async () => {
  await w.close();
});

const op = () => operatorActor(w.operator);
const grantTo = (
  orgOwner: string,
  orgId: string,
  email = "operator@backoffice.test",
  durationHours = 4,
) =>
  inOrg(w.db, userActor(orgOwner), orgId, (ctx) =>
    grantOperatorAccess(ctx, {
      operatorEmail: email,
      reason: "Resolve escalated field update",
      durationHours,
    }),
  );

describe("8. internal operator cannot access a tenant without a scoped grant", () => {
  it("without a grant: empty queue, open is forbidden, RLS shows nothing", async () => {
    expect(await asTx(w.db, op(), (tx) => listOperatorCases(tx))).toEqual([]);
    await expect(asTx(w.db, op(), (tx) => openOpsCase(tx, caseA.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      asTx(w.db, op(), (tx) => updateOpsCaseAsOperator(tx, caseA.id, { assignToSelf: true })),
    ).rejects.toBeInstanceOf(ForbiddenError);

    for (const table of ["ops_cases", "organizations", "customers", "jobs", "approvals"]) {
      const { rows } = await rawAsUser(w.pg, w.operator, `select * from public.${table}`);
      expect(rows).toHaveLength(0);
    }
  });

  it("the denied open attempt is audited in the tenant's log", async () => {
    const denials = await count(
      w.pg,
      `select 1 from public.audit_log
        where action = 'authz.denied' and actor_type = 'internal_operator' and actor_id = $1
          and organization_id = $2 and entity_id = $3`,
      [w.operator, w.orgA.id, caseA.id],
    );
    expect(denials).toBeGreaterThanOrEqual(1);
  });

  it("with a grant for org A: sees org A's case only, and each open is audited", async () => {
    const grant = await grantTo(w.orgA.owner, w.orgA.id);
    try {
      const cases = await asTx(w.db, op(), (tx) => listOperatorCases(tx));
      expect(cases.map((c) => c.id)).toEqual([caseA.id]);
      expect(cases[0]?.organizationName).toBe("Org A");

      const detail = await asTx(w.db, op(), (tx) => openOpsCase(tx, caseA.id));
      expect(detail.opsCase.evidence).toEqual({ message_excerpt: "hoe 8 hrs wilson" });
      expect(detail.timeline.map((e) => e.type)).toContain("ops_case.created");

      await expect(asTx(w.db, op(), (tx) => openOpsCase(tx, caseB.id))).rejects.toBeInstanceOf(
        ForbiddenError,
      );

      const views = await count(
        w.pg,
        `select 1 from public.audit_log
          where action = 'ops_case.viewed' and actor_type = 'internal_operator' and actor_id = $1 and entity_id = $2`,
        [w.operator, caseA.id],
      );
      expect(views).toBe(1);

      // A grant scopes ops-case access; it does not open up the rest of the tenant's records.
      const { rows } = await rawAsUser(w.pg, w.operator, `select * from public.customers`);
      expect(rows).toHaveLength(0);
    } finally {
      await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        revokeOperatorAccess(ctx, grant.id),
      );
    }
  });

  it("operator can work a granted case with audit + event", async () => {
    const grant = await grantTo(w.orgA.owner, w.orgA.id);
    try {
      const updated = await asTx(w.db, op(), (tx) =>
        updateOpsCaseAsOperator(tx, caseA.id, { assignToSelf: true }),
      );
      expect(updated.status).toBe("assigned");
      expect(updated.assignedOperatorUserId).toBe(w.operator);
      expect(
        await count(
          w.pg,
          `select 1 from public.audit_log where action = 'ops_case.updated' and entity_id = $1`,
          [caseA.id],
        ),
      ).toBe(1);
    } finally {
      await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        revokeOperatorAccess(ctx, grant.id),
      );
    }
  });

  it("revoked grants stop access immediately", async () => {
    const grant = await grantTo(w.orgA.owner, w.orgA.id);
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      revokeOperatorAccess(ctx, grant.id),
    );
    expect(await asTx(w.db, op(), (tx) => listOperatorCases(tx))).toEqual([]);
    await expect(asTx(w.db, op(), (tx) => openOpsCase(tx, caseA.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'operator_grant.revoked' and entity_id = $1`,
        [grant.id],
      ),
    ).toBe(1);
  });

  it("expired grants give no access", async () => {
    const grant = await grantTo(w.orgA.owner, w.orgA.id);
    await w.pg.query(
      `update public.internal_operator_grants set expires_at = now() - interval '1 minute' where id = $1`,
      [grant.id],
    );
    expect(await asTx(w.db, op(), (tx) => listOperatorCases(tx))).toEqual([]);
    await expect(asTx(w.db, op(), (tx) => openOpsCase(tx, caseA.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      revokeOperatorAccess(ctx, grant.id),
    );
  });

  it("deactivated internal staff lose access even with a live grant", async () => {
    const grant = await grantTo(w.orgA.owner, w.orgA.id);
    await w.pg.query(`update public.internal_staff set active = false where user_id = $1`, [
      w.operator,
    ]);
    try {
      await expect(asTx(w.db, op(), (tx) => listOperatorCases(tx))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      const { rows } = await rawAsUser(w.pg, w.operator, `select * from public.ops_cases`);
      expect(rows).toHaveLength(0);
    } finally {
      await w.pg.query(`update public.internal_staff set active = true where user_id = $1`, [
        w.operator,
      ]);
      await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        revokeOperatorAccess(ctx, grant.id),
      );
    }
  });

  it("a grant row for a non-staff user gives nothing", async () => {
    await w.pg.query(
      `insert into public.internal_operator_grants (organization_id, operator_user_id, reason, expires_at)
       values ($1, $2, 'misconfigured', now() + interval '1 hour')`,
      [w.orgA.id, w.outsider],
    );
    await expect(
      asTx(w.db, operatorActor(w.outsider), (tx) => listOperatorCases(tx)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await rawAsUser(w.pg, w.outsider, `select * from public.ops_cases`);
    expect(rows).toHaveLength(0);
  });

  it("tenant membership never substitutes for a grant on the ops console", async () => {
    // An internal staffer who is also an owner of org B still needs a grant to work org B cases.
    const staffOwner = await createUser(w.pg, "staff-owner@b.test");
    await w.pg.query(`insert into public.internal_staff (user_id, role) values ($1, 'ops_agent')`, [
      staffOwner,
    ]);
    await w.pg.query(
      `insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')`,
      [w.orgB.id, staffOwner],
    );
    expect(await asTx(w.db, operatorActor(staffOwner), (tx) => listOperatorCases(tx))).toEqual([]);
    await expect(
      asTx(w.db, operatorActor(staffOwner), (tx) => openOpsCase(tx, caseB.id)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a regular tenant user cannot use the operator console at all", async () => {
    await expect(
      asTx(w.db, userActor(w.orgA.owner), (tx) => listOperatorCases(tx)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("unknown case ids are not found", async () => {
    await expect(
      asTx(w.db, op(), (tx) => openOpsCase(tx, "00000000-0000-4000-8000-00000000dead")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("grant management", () => {
  it("only owners can grant; grants must target active internal staff", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.officeAdmin), w.orgA.id, (ctx) =>
        grantOperatorAccess(ctx, {
          operatorEmail: "operator@backoffice.test",
          reason: "please help",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      grantTo(w.orgA.owner, w.orgA.id, "outsider@elsewhere.test"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(grantTo(w.orgB.owner, w.orgA.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("clients cannot create grants directly", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.internal_operator_grants (organization_id, operator_user_id, reason, expires_at)
         values ($1, $2, 'x', now() + interval '1 day')`,
        [w.orgA.id, w.operator],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("grant listing reports liveness from the database clock", async () => {
    const grant = await grantTo(w.orgA.owner, w.orgA.id);
    const before = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      listOperatorGrants(ctx),
    );
    expect(before.find((g) => g.id === grant.id)?.active).toBe(true);
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      revokeOperatorAccess(ctx, grant.id),
    );
    const after = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      listOperatorGrants(ctx),
    );
    expect(after.find((g) => g.id === grant.id)?.active).toBe(false);
    expect(after.every((g) => g.organizationId === w.orgA.id)).toBe(true);
  });

  it("re-granting supersedes the previous active grant and is audited", async () => {
    const first = await grantTo(w.orgA.owner, w.orgA.id);
    const second = await grantTo(w.orgA.owner, w.orgA.id);
    const { rows } = await w.pg.query<{ revoked_at: unknown }>(
      `select revoked_at from public.internal_operator_grants where id = $1`,
      [first.id],
    );
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'operator_grant.created' and entity_id = $1`,
        [second.id],
      ),
    ).toBe(1);
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      revokeOperatorAccess(ctx, second.id),
    );
  });
});

describe("tenant view of ops cases", () => {
  it("staff see their org's cases; field employees do not", async () => {
    const cases = await inOrg(w.db, userActor(w.orgA.manager), w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.map((c) => c.id)).toEqual([caseA.id]);
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) => listOrgOpsCases(ctx)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creating an ops case writes an event and an audit record", async () => {
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'ops_case.created' and entity_id = $1`,
        [caseA.id],
      ),
    ).toBe(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'ops_case.created' and entity_id = $1`,
        [caseA.id],
      ),
    ).toBe(1);
  });
});
