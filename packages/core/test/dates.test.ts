// Calendar dates (SQL `date`) must round-trip unchanged through both database adapters in any
// process timezone. Run under several zones with `pnpm --filter @backoffice/core test:tz`.

import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDatabase, createPgPool } from "../src/db/pg";
import type { Database } from "../src/db/types";
import { dateOnly } from "../src/rows";
import { createTestDatabase, type TestDatabase } from "./helpers/db";

// Around US DST changes, year ends and leap day: the dates most likely to shift by a day.
const DATES = ["2026-01-05", "2026-03-08", "2026-11-01", "2026-12-31", "2028-02-29"];

let t: TestDatabase;
let server: PGLiteSocketServer;
let pool: pg.Pool;
let pgDb: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  const port = 56_000 + Math.floor(Math.random() * 4_000);
  server = new PGLiteSocketServer({ db: t.pg, port, host: "127.0.0.1" });
  await server.start();
  pool = createPgPool(`postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, 1);
  pgDb = createPgDatabase(pool);
});

afterAll(async () => {
  await pool?.end();
  await server?.stop();
  await t?.close();
});

async function selectDate(db: Database, value: string): Promise<unknown> {
  return db.transaction(async (exec) => {
    const { rows } = await exec.query<{ d: unknown }>("select $1::date as d", [value]);
    return rows[0]?.d;
  });
}

describe(`calendar dates in timezone ${process.env.TZ ?? "(process default)"}`, () => {
  it("runs in the timezone the runner asked for", () => {
    if (process.env.TZ) {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(process.env.TZ);
    }
  });

  it.each(DATES)("PGlite adapter returns %s unchanged as text", async (value) => {
    await expect(selectDate(t.db, value)).resolves.toBe(value);
  });

  it.each(DATES)("node-postgres adapter returns %s unchanged as text", async (value) => {
    await expect(selectDate(pgDb, value)).resolves.toBe(value);
  });

  it("round-trips dates through a real table", async () => {
    await t.pg.exec("create temp table if not exists tz_probe (d date)");
    for (const value of DATES) {
      await pgDb.transaction((exec) => exec.query("insert into tz_probe values ($1)", [value]));
    }
    const read = await pgDb.transaction((exec) =>
      exec.query<{ d: unknown }>("select d from tz_probe order by d"),
    );
    expect(read.rows.map((r) => dateOnly(r.d))).toEqual([...DATES].sort());
  });

  it("refuses to guess when an adapter hands back a JS Date", () => {
    expect(() => dateOnly(new Date("2026-01-05T00:00:00Z"))).toThrow(/configure the driver/);
    expect(() => dateOnly("2026-1-5")).toThrow(TypeError);
  });
});
