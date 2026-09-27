// M2-T10: agent-callable createLead domain tool (MASTER_SPEC §8 GREEN action). Idempotent on
// (organization_id, idempotency_key) so a retried/duplicate tool call never creates a second lead.

import {
  actorUserId,
  createLeadInput,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  type Communication,
  type CreateLeadInput,
  type Lead,
  type LeadActivity,
  type LeadStatus,
  type UUID,
} from "@backoffice/domain";
import { toLead, toLeadActivity, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

/** originatingCommunicationId has no entry in the shared entityRef map, so check it directly. */
async function assertCommunicationInOrg(
  ctx: ServiceContext,
  communicationId: UUID | undefined,
): Promise<void> {
  if (communicationId === undefined) return;
  const { rows } = await ctx.tx.asService(
    `select 1 from public.communications where id = $1 and organization_id = $2`,
    [communicationId, ctx.organizationId],
  );
  if (rows.length === 0) throw new NotFoundError("communication", communicationId);
}

export interface CreateLeadResult {
  lead: Lead;
  /** False when the idempotency key matched an existing lead (nothing new written). */
  created: boolean;
}

/**
 * Create a draft lead (server/agent/member). Idempotent on (organization_id, idempotency_key):
 * a retried call with the same key returns the original lead and writes no new event or audit.
 */
export async function createLead(
  ctx: ServiceContext,
  input: CreateLeadInput,
): Promise<CreateLeadResult> {
  await ctx.authorize("lead.write");
  const data = parseInput(createLeadInput, input);
  await assertEntityInOrg(ctx, "customer", data.customerId);
  await assertEntityInOrg(ctx, "employee", data.assignedToEmployeeId);
  await assertCommunicationInOrg(ctx, data.originatingCommunicationId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.leads
       (organization_id, source, first_name, last_name, company, phone, email,
        customer_id, assigned_to_employee_id, originating_communication_id, description, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
     returning *`,
    [
      ctx.organizationId,
      data.source,
      data.firstName ?? null,
      data.lastName ?? null,
      data.company ?? null,
      data.phone ?? null,
      data.email ?? null,
      data.customerId ?? null,
      data.assignedToEmployeeId ?? null,
      data.originatingCommunicationId ?? null,
      data.description ?? null,
      data.idempotencyKey,
    ],
  );

  if (!rows[0]) {
    const existing = await ctx.tx.asService<Row>(
      `select * from public.leads where organization_id = $1 and idempotency_key = $2`,
      [ctx.organizationId, data.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error("lead idempotency conflict without existing row");
    return { lead: toLead(existing.rows[0]), created: false };
  }

  const lead = toLead(rows[0]);
  // A DB trigger (leads_audit, 0004_leads.sql) writes the audit_log row for this insert; the
  // event is the only thing the service itself must record.
  await recordEvent(ctx, {
    type: EVENT_TYPES.leadCreated,
    entityType: "lead",
    entityId: lead.id,
    idempotencyKey: `lead.created:${lead.id}`,
    payload: { source: lead.source, status: lead.status },
  });
  return { lead, created: true };
}

export async function getLead(ctx: ServiceContext, id: UUID): Promise<Lead | null> {
  await ctx.authorize("lead.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.leads where id = $1 and organization_id = $2`,
    [id, ctx.organizationId],
  );
  return rows[0] ? toLead(rows[0]) : null;
}

export interface LinkedCallOutcome {
  lead: Lead;
  activity: LeadActivity;
}

/**
 * M2-T22: attach an ended call's outcome to any lead(s) it originated (`originating_communication_id`).
 * The caller (recordCallDisposition) only invokes this the first time a call-ended event is
 * processed, so a replayed webhook links nothing twice — no separate idempotency key is needed here.
 *
 * A fresh lead's "next step" is to be marked contacted, since a lead can only exist here because a
 * live conversation created it (the create_lead tool runs mid-call); a lead already past `new` (e.g.
 * qualified/converted by other means) keeps its status. The call's summary is only copied onto the
 * lead's timeline while the communication's retention status is still `active` — once retention
 * purges (M2-T25) a communication's content, this must stop copying it out to new places.
 */
export async function linkCallOutcomeToLeads(
  ctx: ServiceContext,
  params: { communication: Communication; disposition: string; durationSeconds: number | null },
): Promise<LinkedCallOutcome[]> {
  await ctx.authorize("lead.write");
  const { communication } = params;
  const { rows } = await ctx.tx.asService<Row>(
    `select * from public.leads where organization_id = $1 and originating_communication_id = $2`,
    [ctx.organizationId, communication.id],
  );

  const results: LinkedCallOutcome[] = [];
  for (const leadRow of rows) {
    const lead = toLead(leadRow);
    const nextStatus: LeadStatus = lead.status === "new" ? "contacted" : lead.status;
    const includeContent = communication.retentionStatus === "active";

    const { rows: updatedRows } = await ctx.tx.asService<Row>(
      `update public.leads set status = $2 where id = $1 and organization_id = $3 returning *`,
      [lead.id, nextStatus, ctx.organizationId],
    );
    const updatedLead = toLead(updatedRows[0] as Row);

    const { rows: activityRows } = await ctx.tx.asService<Row>(
      `insert into public.lead_activities
         (organization_id, lead_id, activity_type, actor_type, actor_user_id, communication_id, body, metadata)
       values ($1, $2, 'communication', $3, $4, $5, $6, $7)
       returning *`,
      [
        ctx.organizationId,
        lead.id,
        ctx.actor.type,
        actorUserId(ctx.actor),
        communication.id,
        includeContent ? communication.summary : null,
        {
          disposition: params.disposition,
          duration_seconds: params.durationSeconds,
          previous_status: lead.status,
          status: nextStatus,
          retention_status: communication.retentionStatus,
        },
      ],
    );
    const activity = toLeadActivity(activityRows[0] as Row);

    await recordEvent(ctx, {
      type: EVENT_TYPES.leadCallOutcomeLinked,
      entityType: "lead",
      entityId: lead.id,
      idempotencyKey: `lead.call_outcome_linked:${lead.id}:${communication.id}`,
      payload: { disposition: params.disposition, status: nextStatus },
    });

    results.push({ lead: updatedLead, activity });
  }
  return results;
}
