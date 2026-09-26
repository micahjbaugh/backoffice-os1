// M3-T06: draft material usage service. See draft-records.ts for the shared idempotency and
// authorization rationale.

import {
  createDraftMaterialUsageInput,
  EVENT_TYPES,
  parseInput,
  type CreateDraftMaterialUsageInput,
  type MaterialUsage,
} from "@backoffice/domain";
import { toMaterialUsage, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { findFactKeyRow } from "./draft-fact";
import { assertCommunicationInOrg, assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

export interface CreateDraftMaterialUsageResult {
  materialUsage: MaterialUsage;
  created: boolean;
}

export async function createDraftMaterialUsage(
  ctx: ServiceContext,
  input: CreateDraftMaterialUsageInput,
): Promise<CreateDraftMaterialUsageResult> {
  await ctx.authorize("material_usage.write");
  const data = parseInput(createDraftMaterialUsageInput, input);
  await assertEntityInOrg(ctx, "job", data.jobId);
  await assertCommunicationInOrg(ctx, data.sourceCommunicationId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.material_usages
       (organization_id, job_id, description, quantity, unit, source_communication_id, confidence, evidence, fact_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (organization_id, source_communication_id, fact_key)
       where source_communication_id is not null and fact_key is not null do nothing
     returning *`,
    [
      ctx.organizationId,
      data.jobId,
      data.description,
      data.quantity ?? null,
      data.unit ?? null,
      data.sourceCommunicationId ?? null,
      data.confidence,
      data.evidence,
      data.factKey ?? null,
    ],
  );

  if (!rows[0]) {
    const existing = await findFactKeyRow(ctx, "public.material_usages", data.sourceCommunicationId, data.factKey);
    if (!existing) throw new Error("material usage idempotency conflict without existing row");
    return { materialUsage: toMaterialUsage(existing), created: false };
  }

  const materialUsage = toMaterialUsage(rows[0]);
  await recordEvent(ctx, {
    type: EVENT_TYPES.materialUsageDrafted,
    entityType: "material_usage",
    entityId: materialUsage.id,
    idempotencyKey: `material_usage.drafted:${materialUsage.id}`,
    payload: { job_id: materialUsage.jobId, description: materialUsage.description, quantity: materialUsage.quantity },
  });
  return { materialUsage, created: true };
}
