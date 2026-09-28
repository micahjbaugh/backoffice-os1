import { actorLabel, actorUserId, type AuditLogEntry, type UUID } from "@backoffice/domain";
import { buildPage, decodeCursor, resolvePageSize } from "../pagination";
import type { CursorPage, PageParams } from "../pagination";
import { toAuditLogEntry, type Row } from "../rows";
import type { ServiceContext } from "../runtime";

interface CreatedAtCursor {
  createdAt: string;
  id: string;
}

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

export function listAudit(ctx: ServiceContext, limit?: number): Promise<AuditLogEntry[]>;
export function listAudit(
  ctx: ServiceContext,
  page: PageParams,
): Promise<CursorPage<AuditLogEntry>>;
export async function listAudit(
  ctx: ServiceContext,
  arg?: number | PageParams,
): Promise<AuditLogEntry[] | CursorPage<AuditLogEntry>> {
  await ctx.authorize("audit.read");
  if (arg === undefined || typeof arg === "number") {
    const { rows } = await ctx.scoped<Row>(
      `select * from public.audit_log
        where organization_id = $1
        order by created_at desc, id desc
        limit $2`,
      [ctx.organizationId, arg ?? 50],
    );
    return rows.map(toAuditLogEntry);
  }
  const limit = resolvePageSize(arg.limit);
  const cursor = decodeCursor<CreatedAtCursor>(arg.cursor);
  const { rows } = await ctx.scoped<Row>(
    `select * from public.audit_log
      where organization_id = $1
        and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
      order by created_at desc, id desc
      limit $4`,
    [ctx.organizationId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const entries = rows.map(toAuditLogEntry);
  return buildPage(entries, limit, (e) => ({ createdAt: e.createdAt, id: e.id }));
}
