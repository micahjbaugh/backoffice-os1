// M3-T06: draft equipment usage service. See draft-records.ts for the shared idempotency and
// authorization rationale.

import {
  createDraftEquipmentUsageInput,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  type CreateDraftEquipmentUsageInput,
  type EquipmentUsage,
  type UUID,
} from "@backoffice/domain";
import { toEquipmentUsage, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { findFactKeyRow } from "./draft-fact";
import { assertCommunicationInOrg, assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

/** equipment has no entry in the shared entityRef map (it is not a polymorphic entity_type). */
async function assertEquipmentInOrg(ctx: ServiceContext, equipmentId: UUID): Promise<void> {
  const { rows } = await ctx.tx.asService(
    `select 1 from public.equipment where id = $1 and organization_id = $2`,
    [equipmentId, ctx.organizationId],
  );
  if (rows.length === 0) throw new NotFoundError("equipment", equipmentId);
}

export interface CreateDraftEquipmentUsageResult {
  equipmentUsage: EquipmentUsage;
  created: boolean;
}

export async function createDraftEquipmentUsage(
  ctx: ServiceContext,
  input: CreateDraftEquipmentUsageInput,
): Promise<CreateDraftEquipmentUsageResult> {
  await ctx.authorize("equipment_usage.write");
  const data = parseInput(createDraftEquipmentUsageInput, input);
  await assertEquipmentInOrg(ctx, data.equipmentId);
  await assertEntityInOrg(ctx, "job", data.jobId);
  await assertCommunicationInOrg(ctx, data.sourceCommunicationId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.equipment_usages
       (organization_id, equipment_id, job_id, hours, source_communication_id, confidence, evidence, fact_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (organization_id, source_communication_id, fact_key)
       where source_communication_id is not null and fact_key is not null do nothing
     returning *`,
    [
      ctx.organizationId,
      data.equipmentId,
      data.jobId,
      data.hours ?? null,
      data.sourceCommunicationId ?? null,
      data.confidence,
      data.evidence,
      data.factKey ?? null,
    ],
  );

  if (!rows[0]) {
    const existing = await findFactKeyRow(
      ctx,
      "public.equipment_usages",
      data.sourceCommunicationId,
      data.factKey,
    );
    if (!existing) throw new Error("equipment usage idempotency conflict without existing row");
    return { equipmentUsage: toEquipmentUsage(existing), created: false };
  }

  const equipmentUsage = toEquipmentUsage(rows[0]);
  await recordEvent(ctx, {
    type: EVENT_TYPES.equipmentUsageDrafted,
    entityType: "equipment_usage",
    entityId: equipmentUsage.id,
    idempotencyKey: `equipment_usage.drafted:${equipmentUsage.id}`,
    payload: {
      job_id: equipmentUsage.jobId,
      equipment_id: equipmentUsage.equipmentId,
      hours: equipmentUsage.hours,
    },
  });
  return { equipmentUsage, created: true };
}
