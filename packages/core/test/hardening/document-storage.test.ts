// PH-T03: the documents bucket's storage.objects rows are scoped to their organization's folder on
// the same two axes the public.documents metadata table already uses (migrations 0001/0002:
// member-read, owner/office_admin/manager write) — proving cross-tenant access is impossible at the
// storage layer itself, not only in application code, the same way migration 0017's tests do for
// ordinary tables.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerDocument, requestDocumentDownload } from "../../src";
import { count, inOrg, rawAsUser, userActor } from "../helpers/db";
import { createWorld, type World } from "../helpers/fixtures";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

async function seedObject(orgId: string, path: string): Promise<void> {
  await w.pg.query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [
    `${orgId}/${path}`,
  ]);
}

describe("documents storage bucket RLS", () => {
  it("a member can select their own organization's objects", async () => {
    await seedObject(w.orgA.id, "receipts/a.pdf");
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `select 1 from storage.objects where bucket_id = 'documents' and name = $1`,
      [`${w.orgA.id}/receipts/a.pdf`],
    );
    expect(rows).toHaveLength(1);
  });

  it("a member cannot select another organization's objects, even by exact path", async () => {
    await seedObject(w.orgB.id, "receipts/b.pdf");
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `select 1 from storage.objects where bucket_id = 'documents' and name = $1`,
      [`${w.orgB.id}/receipts/b.pdf`],
    );
    expect(rows).toHaveLength(0);
  });

  it("field employees cannot write objects (staff-only policy)", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.fieldEmployee,
        `insert into storage.objects (bucket_id, name) values ('documents', $1) returning id`,
        [`${w.orgA.id}/receipts/c.pdf`],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("staff can write and delete their own organization's objects", async () => {
    const path = `${w.orgA.id}/receipts/d.pdf`;
    const inserted = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `insert into storage.objects (bucket_id, name) values ('documents', $1) returning id`,
      [path],
    );
    expect(inserted.rows).toHaveLength(1);
    const deleted = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `delete from storage.objects where name = $1 returning id`,
      [path],
    );
    expect(deleted.rows).toHaveLength(1);
  });

  it("a member cannot write into another organization's folder", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into storage.objects (bucket_id, name) values ('documents', $1) returning id`,
        [`${w.orgB.id}/receipts/e.pdf`],
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("public.documents.storage_path is scoped to its own organization", () => {
  it("rejects a storage_path under a different organization's folder", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        registerDocument(ctx, { storagePath: `${w.orgB.id}/receipts/r2.pdf`, fileName: "r2.pdf" }),
      ),
    ).rejects.toThrow();
  });

  it("accepts a storage_path under the caller's own organization folder", async () => {
    const doc = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      registerDocument(ctx, { storagePath: `${w.orgA.id}/receipts/r3.pdf`, fileName: "r3.pdf" }),
    );
    expect(doc.storagePath).toBe(`${w.orgA.id}/receipts/r3.pdf`);
  });
});

describe("requestDocumentDownload", () => {
  it("audits the download and returns the document metadata", async () => {
    const doc = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      registerDocument(ctx, { storagePath: `${w.orgA.id}/receipts/r4.pdf`, fileName: "r4.pdf" }),
    );
    const result = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      requestDocumentDownload(ctx, doc.id),
    );
    expect(result.id).toBe(doc.id);
    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        doc.id,
        "document.downloaded",
      ]),
    ).toBe(1);
  });

  it("rejects a download request for another organization's document", async () => {
    const doc = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      registerDocument(ctx, { storagePath: `${w.orgA.id}/receipts/r5.pdf`, fileName: "r5.pdf" }),
    );
    await expect(
      inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) =>
        requestDocumentDownload(ctx, doc.id),
      ),
    ).rejects.toThrow(/not found/);
    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        doc.id,
        "document.downloaded",
      ]),
    ).toBe(0);
  });
});
