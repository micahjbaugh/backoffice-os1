// Shared seed/assert helpers for the M3-T06 draft record service tests.

import { randomUUID } from "node:crypto";
import type { Actor } from "@backoffice/domain";
import { recordMessage } from "../../src";
import { count, inOrg } from "./db";
import type { World } from "./fixtures";

export const fieldCapture: Actor = { type: "agent", name: "field-capture-test" };

/** A communication id in `orgId` to use as a draft's source_communication_id. */
export async function seedCommunicationId(w: World, orgId: string): Promise<string> {
  const { communication } = await inOrg(w.db, fieldCapture, orgId, (ctx) =>
    recordMessage(ctx, { direction: "inbound", provider: "twilio", providerConversationId: `sms-${randomUUID()}` }),
  );
  return communication.id;
}

export async function seedEmployee(w: World, orgId: string): Promise<string> {
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.employees (organization_id, display_name) values ($1, $2) returning id`,
    [orgId, `Crew ${randomUUID()}`],
  );
  return (rows[0] as { id: string }).id;
}

export async function seedEquipment(w: World, orgId: string): Promise<string> {
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.equipment (organization_id, name, type, aliases)
     values ($1, 'John Deere 350G', 'excavator', array['Hoe']) returning id`,
    [orgId],
  );
  return (rows[0] as { id: string }).id;
}

export const eventCount = (w: World, type: string, id: string): Promise<number> =>
  count(w.pg, `select 1 from public.business_events where type = $1 and entity_id = $2`, [type, id]);

export const auditCount = (w: World, action: string, id: string): Promise<number> =>
  count(w.pg, `select 1 from public.audit_log where action = $1 and entity_id = $2`, [action, id]);

export const factRowCount = (
  w: World,
  table: string,
  communicationId: string,
  factKey: string,
): Promise<number> =>
  count(w.pg, `select 1 from public.${table} where source_communication_id = $1 and fact_key = $2`, [
    communicationId,
    factKey,
  ]);
