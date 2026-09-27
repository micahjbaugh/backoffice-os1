import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createPgDatabase, createPgPool } from "../src/db/pg";
import {
  createApproval,
  decideApproval,
  inTenant,
  runAs,
  createApprovalRuleVersion,
  retireRule,
  listOperatorCases,
  grantOperatorAccess,
  revokeOperatorAccess,
  openOpsCase,
} from "../src";

// The local stack's public anon key: explicit env, then the app's .env.local, then the CLI (clean CI).
function localAnonKey(): string {
  if (process.env.BO_LIVE_ANON_KEY) return process.env.BO_LIVE_ANON_KEY;
  const envFile = "../../apps/web/.env.local";
  const fromFile = existsSync(envFile)
    ? readFileSync(envFile, "utf8")
        .match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.*)$/m)?.[1]
        ?.trim()
    : undefined;
  if (fromFile) return fromFile;
  const status = execSync("pnpm exec supabase status -o env", { encoding: "utf8" });
  return status.match(/^ANON_KEY="?([^"\n]*)"?$/m)?.[1] ?? "";
}

// Explicit opt-in: exercises only the seeded local Docker stack and leaves labelled test records.
describe.skipIf(process.env.BO_LIVE_TEST !== "1")("real local Supabase", () => {
  const pool = createPgPool("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  const db = createPgDatabase(pool);
  const orgA = "aaaaaaaa-0000-4000-8000-000000000001";
  const orgB = "bbbbbbbb-0000-4000-8000-000000000001";
  const owner = "11111111-1111-4111-8111-111111111111";
  const admin = "11111111-1111-4111-8111-111111111112";
  const crew = "11111111-1111-4111-8111-111111111113";
  const operator = {
    type: "internal_operator" as const,
    userId: "99999999-9999-4999-8999-999999999999",
  };
  const tenant = <T>(userId: string, fn: (ctx: ReturnType<typeof inTenant>) => Promise<T>) =>
    runAs(db, { type: "user", userId }, (tx) => fn(inTenant(tx, orgA)));
  const tokens = new Map<string, string>();
  let anon = "";
  afterAll(async () => {
    await pool.end();
  });

  it("signs in every seeded demo account through real Auth", async () => {
    anon = localAnonKey();
    expect(anon.length).toBeGreaterThan(10);
    for (const email of [
      "owner@acme.test",
      "admin@acme.test",
      "crew@acme.test",
      "owner@bravo.test",
      "ops@backoffice.test",
    ]) {
      const response = await fetch("http://127.0.0.1:54321/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { apikey: anon, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "backoffice-dev-1" }),
      });
      expect(response.status, email).toBe(200);
      const data = (await response.json()) as { access_token: string };
      tokens.set(email, data.access_token);
    }
  });

  it("enforces tenant isolation through real PostgREST JWTs", async () => {
    for (const [email, org] of [
      ["owner@acme.test", orgA],
      ["owner@bravo.test", orgB],
    ]) {
      const response = await fetch(
        "http://127.0.0.1:54321/rest/v1/customers?select=organization_id",
        { headers: { apikey: anon, Authorization: `Bearer ${tokens.get(email ?? "")}` } },
      );
      expect(response.status).toBe(200);
      const rows = (await response.json()) as { organization_id: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.organization_id === org)).toBe(true);
    }
  });

  it("supports authenticated role switching and prevents cross-tenant job writes", async () => {
    await runAs(db, { type: "user", userId: owner }, async (tx) => {
      const role = await tx.asUser<{ current_user: string }>("select current_user");
      expect(role.rows[0]?.current_user).toBe("authenticated");
      const changed = await tx.asUser(
        "update public.jobs set name = 'ILLEGAL' where organization_id = $1",
        [orgB],
      );
      expect(changed.rowCount).toBe(0);
      const trusted = await tx.asService<{ current_user: string }>("select current_user");
      expect(trusted.rows[0]?.current_user).toBe("postgres");
    });
    const ownership = await pool.query(
      "select tableowner from pg_tables where schemaname='public' and tablename='approvals'",
    );
    expect(ownership.rows[0].tableowner).toBe("postgres");
  });

  it("rejects crew decisions and direct approval writes", async () => {
    const { approval } = await tenant(owner, (ctx) =>
      createApproval(ctx, {
        title: "Live verification: forbidden decision",
        type: "purchase",
        amountCents: 45000,
        idempotencyKey: randomUUID(),
      }),
    );
    await expect(
      tenant(crew, (ctx) => decideApproval(ctx, { approvalId: approval.id, decision: "approved" })),
    ).rejects.toThrow();
    const response = await fetch(`http://127.0.0.1:54321/rest/v1/approvals?id=eq.${approval.id}`, {
      method: "PATCH",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${tokens.get("owner@acme.test")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(response.status).toBe(403);
    await tenant(owner, (ctx) =>
      decideApproval(ctx, {
        approvalId: approval.id,
        decision: "rejected",
        note: "Verification complete",
      }),
    );
  });

  it("serializes concurrent decisions on separate real Postgres connections", async () => {
    const { approval } = await tenant(owner, (ctx) =>
      createApproval(ctx, {
        title: "Live verification: concurrent decisions",
        type: "purchase",
        amountCents: 12300,
        idempotencyKey: randomUUID(),
      }),
    );
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        tenant(owner, (ctx) =>
          decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
        ),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(2);
    const events = await pool.query(
      "select id from business_events where entity_id=$1 and type='approval.decided'",
      [approval.id],
    );
    const audits = await pool.query(
      "select id from audit_log where entity_id=$1 and action='approval.decided'",
      [approval.id],
    );
    expect(events.rowCount).toBe(1);
    expect(audits.rowCount).toBe(1);
  });

  it("enforces financial delegation and retires the test rule", async () => {
    const { approval } = await tenant(owner, (ctx) =>
      createApproval(ctx, {
        title: "Live verification: delegated purchase",
        type: "purchase",
        amountCents: 45000,
        idempotencyKey: randomUUID(),
      }),
    );
    await expect(
      tenant(admin, (ctx) =>
        decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
      ),
    ).rejects.toThrow();
    const rule = await tenant(owner, (ctx) =>
      createApprovalRuleVersion(ctx, {
        ruleKey: `live-${randomUUID()}`,
        roles: ["office_admin"],
        approvalTypes: ["purchase"],
        maxAmountCents: 50000,
      }),
    );
    try {
      const result = await tenant(admin, (ctx) =>
        decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
      );
      expect(result.approval.status).toBe("approved");
    } finally {
      await tenant(owner, (ctx) => retireRule(ctx, rule.id));
    }
  });

  it("requires a scoped operator grant, audits access, and honors revocation", async () => {
    expect(await runAs(db, operator, (tx) => listOperatorCases(tx))).toHaveLength(0);
    const grant = await tenant(owner, (ctx) =>
      grantOperatorAccess(ctx, {
        operatorEmail: "ops@backoffice.test",
        reason: "Local live-stack verification",
        durationHours: 1,
      }),
    );
    try {
      const cases = await runAs(db, operator, (tx) => listOperatorCases(tx));
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.every((c) => c.organizationId === orgA)).toBe(true);
      await runAs(db, operator, (tx) => openOpsCase(tx, cases[0]?.id ?? "missing-case"));
      const audits = await pool.query(
        "select id from audit_log where entity_id=$1 and action='ops_case.viewed'",
        [cases[0]?.id ?? "missing-case"],
      );
      expect(audits.rowCount).toBeGreaterThan(0);
    } finally {
      await tenant(owner, (ctx) => revokeOperatorAccess(ctx, grant.id));
    }
    expect(await runAs(db, operator, (tx) => listOperatorCases(tx))).toHaveLength(0);
  });
});
