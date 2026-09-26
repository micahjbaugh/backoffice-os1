import { actorLabel, actorUserId, type AuditLogEntry, type UUID } from "@backoffice/domain";
import { toAuditLogEntry, type Row } from "../rows";
import type { ServiceContext } from "../runtime";

export interface WriteAuditInput {
  action: string;
  entityType?: string;
  entityId?: UUID;
  approvalId?: UUID;
  sourceEventId?: UUID;
  /** Sanitized details only: no secrets, no raw sensitive content. */
  details?: Record<string, unknown>;
}

/**
 * Append an audit record for a consequential action. Server-internal: never exposed as a
 * client-callable action (that would let users forge the audit trail).
 */
export async function writeAudit(
  ctx: ServiceContext,
  input: WriteAuditInput,
): Promise<AuditLogEntry> {
  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.audit_log
       (organization_id, actor_type, actor_id, action, entity_type, entity_id, approval_id, source_event_id, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      ctx.organizationId,
      ctx.actor.type,
      actorUserId(ctx.actor),
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      input.approvalId ?? null,
      input.sourceEventId ?? null,
      { actor_label: actorLabel(ctx.actor), ...input.details },
    ],
  );
  return toAuditLogEntry(rows[0] as Row);
}

export async function listAudit(ctx: ServiceContext, limit = 50): Promise<AuditLogEntry[]> {
  await ctx.authorize("audit.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.audit_log where organization_id = $1 order by created_at desc limit $2`,
    [ctx.organizationId, limit],
  );
  return rows.map(toAuditLogEntry);
}
