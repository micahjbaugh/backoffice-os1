// M2-T05: tenant isolation for the M2 communications/leads tables (0003, 0004).
// Communications/calls/messages/communication_participants are written only by trusted server
// code (see 0003's header), so these rows are seeded directly on the privileged test connection
// (bypassing RLS, like a service-role write) and every check below runs as an authenticated
// tenant user through `rawAsUser`, exactly like a PostgREST client would.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawAsUser } from "./helpers/db";
import { createWorld, type OrgFixture, type World } from "./helpers/fixtures";

interface Seed {
  commVoiceId: string;
  leadId: string;
}

let w: World;
let seedA: Seed;
let seedB: Seed;

async function returningId(w: World, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await w.pg.query<{ id: string }>(`${sql} returning id`, params);
  return (rows[0] as { id: string }).id;
}

async function seedCommsAndLead(w: World, org: OrgFixture): Promise<Seed> {
  const commVoiceId = await returningId(
    w,
    `insert into public.communications (organization_id, channel, direction, status)
     values ($1, 'voice', 'inbound', 'completed')`,
    [org.id],
  );
  await w.pg.query(
    `insert into public.calls (organization_id, communication_id, from_number, to_number)
     values ($1, $2, '+15550001111', '+15550002222')`,
    [org.id, commVoiceId],
  );
  await w.pg.query(
    `insert into public.communication_participants (organization_id, communication_id, role, customer_id)
     values ($1, $2, 'customer', $3)`,
    [org.id, commVoiceId, org.customer.id],
  );

  const commSmsId = await returningId(
    w,
    `insert into public.communications (organization_id, channel, direction, status)
     values ($1, 'sms', 'inbound', 'completed')`,
    [org.id],
  );
  await w.pg.query(
    `insert into public.messages (organization_id, communication_id, from_address, to_address, body)
     values ($1, $2, '+15550001111', '+15550002222', 'hello')`,
    [org.id, commSmsId],
  );

  const leadId = await returningId(
    w,
    `insert into public.leads (organization_id, status, source, first_name, phone, originating_communication_id)
     values ($1, 'new', 'voice', 'Jane', '+15550001111', $2)`,
    [org.id, commVoiceId],
  );
  await w.pg.query(
    `insert into public.lead_activities (organization_id, lead_id, activity_type, actor_type, body)
     values ($1, $2, 'note', 'system', 'seed')`,
    [org.id, leadId],
  );

  return { commVoiceId, leadId };
}

beforeAll(async () => {
  w = await createWorld();
  seedA = await seedCommsAndLead(w, w.orgA);
  seedB = await seedCommsAndLead(w, w.orgB);
});
afterAll(async () => {
  await w.close();
});

const TABLES = ["communications", "calls", "messages", "communication_participants", "leads", "lead_activities"];

describe("M2-T05: org A cannot read org B's communications, calls, messages or leads", () => {
  it.each(TABLES)("staff with read access to %s see no org B rows", async (table) => {
    for (const user of [w.orgA.owner, w.orgA.officeAdmin, w.orgA.manager]) {
      const { rows } = await rawAsUser(w.pg, user, `select * from public.${table} where organization_id = $1`, [
        w.orgB.id,
      ]);
      expect(rows).toHaveLength(0);
    }
  });

  it("org A cannot fetch org B's specific communication or lead by id", async () => {
    const { rows: comm } = await rawAsUser(w.pg, w.orgA.owner, `select * from public.communications where id = $1`, [
      seedB.commVoiceId,
    ]);
    expect(comm).toHaveLength(0);
    const { rows: lead } = await rawAsUser(w.pg, w.orgA.owner, `select * from public.leads where id = $1`, [
      seedB.leadId,
    ]);
    expect(lead).toHaveLength(0);
  });

  it("unfiltered queries only ever return the caller's own org", async () => {
    const { rows } = await rawAsUser<{ organization_id: string }>(
      w.pg,
      w.orgA.owner,
      `select organization_id from public.leads`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === w.orgA.id)).toBe(true);
  });
});

describe("M2-T05: org A cannot write org B's communications, calls, messages or leads", () => {
  it("clients cannot write communications/calls/messages/participants in any org (server-only)", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.communications (organization_id, channel, direction) values ($1, 'voice', 'inbound')`,
        [w.orgA.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rawAsUser(w.pg, w.orgA.owner, `update public.calls set disposition = 'x' where id = $1`, [
        seedA.commVoiceId,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it("org A cannot insert, update or delete org B's leads", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.leads (organization_id, status, source) values ($1, 'new', 'manual')`,
        [w.orgB.id],
      ),
    ).rejects.toThrow(/row-level security/);

    const updated = await rawAsUser(w.pg, w.orgA.owner, `update public.leads set status = 'lost' where id = $1`, [
      seedB.leadId,
    ]);
    expect(updated.rowCount).toBe(0);
    const deleted = await rawAsUser(w.pg, w.orgA.owner, `delete from public.leads where id = $1`, [seedB.leadId]);
    expect(deleted.rowCount).toBe(0);

    const { rows } = await w.pg.query<{ status: string }>(`select status from public.leads where id = $1`, [
      seedB.leadId,
    ]);
    expect(rows[0]?.status).toBe("new");
  });

  it("clients cannot write lead_activities in any org (server-only timeline)", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.lead_activities (organization_id, lead_id, activity_type, actor_type) values ($1, $2, 'note', 'user')`,
        [w.orgA.id, seedA.leadId],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("M2-T05: outsiders and anonymous callers see nothing", () => {
  it.each(TABLES)(
    "an unaffiliated authenticated user reads no rows from %s",
    async (table) => {
      const { rows } = await rawAsUser(w.pg, w.outsider, `select * from public.${table}`);
      expect(rows).toHaveLength(0);
    },
  );

  it("anonymous callers are rejected outright", async () => {
    await expect(rawAsUser(w.pg, null, `select * from public.leads`)).rejects.toThrow(/permission denied/);
  });
});
