// PH-T02: cursor pagination for customers, jobs, vendors, audit log, ops cases and the inbox
// (pending approvals, open tasks). Paging through with a small limit must reconstruct exactly the
// same rows, in the same order, as the legacy unbounded call — never skipping or repeating a row.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@backoffice/domain";
import {
  createApproval,
  createCustomer,
  createJob,
  createOpsCase,
  createTask,
  createVendor,
  grantOperatorAccess,
  listAudit,
  listCustomers,
  listJobs,
  listOpenTasks,
  listOperatorCases,
  listOrgOpsCases,
  listPendingApprovals,
  listVendors,
  writeAudit,
  type CursorPage,
} from "../src";
import { asTx, inOrg, operatorActor, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";
import type { ServiceContext } from "../src";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

const system: Actor = { type: "system", name: "pagination-test" };
const owner = () => userActor(w.orgA.owner);
const asOwner = <T>(fn: (ctx: ServiceContext) => Promise<T>) => inOrg(w.db, owner(), w.orgA.id, fn);

/** Page through with a small limit; assert it reconstructs the unpaginated order exactly. */
async function assertPagesReconstructFullList<T extends { id: string }>(
  full: readonly T[],
  fetchPage: (cursor: string | null | undefined) => Promise<CursorPage<T>>,
  pageSize: number,
): Promise<void> {
  const collected: T[] = [];
  let cursor: string | null | undefined;
  let iterations = 0;
  do {
    const page = await fetchPage(cursor);
    expect(page.items.length).toBeLessThanOrEqual(pageSize);
    collected.push(...page.items);
    cursor = page.nextCursor;
    iterations += 1;
    expect(iterations).toBeLessThan(50);
  } while (cursor);
  expect(collected.map((r) => r.id)).toEqual(full.map((r) => r.id));
}

describe("cursor pagination", () => {
  it("customers: pages reconstruct the full ordered list", async () => {
    for (let i = 0; i < 7; i++) {
      await asOwner((ctx) => createCustomer(ctx, { displayName: `Pager Customer ${i}` }));
    }
    const full = await asOwner((ctx) => listCustomers(ctx));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asOwner((ctx) => listCustomers(ctx, { cursor, limit: 3 })),
      3,
    );
  });

  it("vendors: preferred vendors still sort first across pages", async () => {
    for (let i = 0; i < 5; i++) {
      await asOwner((ctx) =>
        createVendor(ctx, { displayName: `Pager Vendor ${i}`, preferred: i % 2 === 0 }),
      );
    }
    const full = await asOwner((ctx) => listVendors(ctx));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asOwner((ctx) => listVendors(ctx, { cursor, limit: 2 })),
      2,
    );
  });

  it("jobs: newest first, stable across pages", async () => {
    for (let i = 0; i < 6; i++) {
      await asOwner((ctx) => createJob(ctx, { name: `Pager Job ${i}` }));
    }
    const full = await asOwner((ctx) => listJobs(ctx));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asOwner((ctx) => listJobs(ctx, { cursor, limit: 4 })),
      4,
    );
  });

  it("audit log: newest first, stable across pages", async () => {
    for (let i = 0; i < 6; i++) {
      await inOrg(w.db, system, w.orgA.id, (ctx) => writeAudit(ctx, { action: `pagination.${i}` }));
    }
    const full = await asOwner((ctx) => listAudit(ctx, 1000));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asOwner((ctx) => listAudit(ctx, { cursor, limit: 4 })),
      4,
    );
  });

  it("ops cases (tenant): stable across pages", async () => {
    for (let i = 0; i < 6; i++) {
      await inOrg(w.db, system, w.orgA.id, (ctx) =>
        createOpsCase(ctx, { title: `Pager case ${i}`, reasonCode: "other" }),
      );
    }
    const full = await asOwner((ctx) => listOrgOpsCases(ctx));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asOwner((ctx) => listOrgOpsCases(ctx, { cursor, limit: 4 })),
      4,
    );
  });

  it("operator cases: stable across pages once granted", async () => {
    await asOwner((ctx) =>
      grantOperatorAccess(ctx, {
        operatorEmail: "operator@backoffice.test",
        reason: "pagination test coverage",
        durationHours: 4,
      }),
    );
    for (let i = 0; i < 6; i++) {
      await inOrg(w.db, system, w.orgA.id, (ctx) =>
        createOpsCase(ctx, { title: `Operator pager case ${i}`, reasonCode: "other" }),
      );
    }
    const op = operatorActor(w.operator);
    const full = await asTx(w.db, op, (tx) => listOperatorCases(tx));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asTx(w.db, op, (tx) => listOperatorCases(tx, { page: { cursor, limit: 4 } })),
      4,
    );
  });

  it("pending approvals (inbox): stable across pages", async () => {
    for (let i = 0; i < 6; i++) {
      await inOrg(w.db, system, w.orgA.id, (ctx) =>
        createApproval(ctx, {
          type: "purchase",
          title: `Pager approval ${i}`,
          idempotencyKey: `pagination-approval-${randomUUID()}`,
        }),
      );
    }
    const full = await asOwner((ctx) => listPendingApprovals(ctx));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asOwner((ctx) => listPendingApprovals(ctx, { cursor, limit: 3 })),
      3,
    );
  });

  it("open tasks (inbox): stable across pages", async () => {
    for (let i = 0; i < 6; i++) {
      await asOwner((ctx) =>
        createTask(ctx, { title: `Pager task ${i}`, priority: i % 2 === 0 ? "urgent" : "high" }),
      );
    }
    const full = await asOwner((ctx) => listOpenTasks(ctx));
    await assertPagesReconstructFullList(
      full,
      (cursor) => asOwner((ctx) => listOpenTasks(ctx, ["high", "urgent"], { cursor, limit: 3 })),
      3,
    );
  });

  it("a tampered cursor is treated as the first page, not an error", async () => {
    const page = await asOwner((ctx) =>
      listCustomers(ctx, { cursor: "not-a-real-cursor", limit: 2 }),
    );
    expect(page.items.length).toBeGreaterThan(0);
  });
});
