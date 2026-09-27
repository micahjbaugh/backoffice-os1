// M3-T15: draft billable opportunity service (scope-change detection). See draft-records.ts for
// the shared idempotency and authorization rationale, and job-notes.ts for the closest sibling —
// billable_opportunities has no `draft` status of its own, but is otherwise the same
// staff-only, client-writable, fact_key-idempotent draft table (0009/0016). Created rows start
// `open`: the owner reviews them in the inbox and decides through decideBillableOpportunity
// (draft-decisions.ts), never by updating status directly (0011 revokes the column).

import {
  createBillableOpportunityInput,
  EVENT_TYPES,
  parseInput,
  type BillableOpportunity,
  type CreateBillableOpportunityInput,
} from "@backoffice/domain";
import { toBillableOpportunity, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { findFactKeyRow } from "./draft-fact";
import { assertCommunicationInOrg, assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

export interface CreateBillableOpportunityResult {
  billableOpportunity: BillableOpportunity;
  created: boolean;
}

export async function createBillableOpportunity(
  ctx: ServiceContext,
  input: CreateBillableOpportunityInput,
): Promise<CreateBillableOpportunityResult> {
  await ctx.authorize("billable_opportunity.write");
  const data = parseInput(createBillableOpportunityInput, input);
  await assertEntityInOrg(ctx, "job", data.jobId);
  await assertCommunicationInOrg(ctx, data.sourceCommunicationId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.billable_opportunities
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
    const existing = await findFactKeyRow(
      ctx,
      "public.billable_opportunities",
      data.sourceCommunicationId,
      data.factKey,
    );
    if (!existing)
      throw new Error("billable opportunity idempotency conflict without existing row");
    return { billableOpportunity: toBillableOpportunity(existing), created: false };
  }

  const billableOpportunity = toBillableOpportunity(rows[0]);
  await recordEvent(ctx, {
    type: EVENT_TYPES.billableOpportunityCreated,
    entityType: "billable_opportunity",
    entityId: billableOpportunity.id,
    idempotencyKey: `billable_opportunity.created:${billableOpportunity.id}`,
    payload: { job_id: billableOpportunity.jobId },
  });
  return { billableOpportunity, created: true };
}
