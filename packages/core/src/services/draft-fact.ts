// Shared idempotency lookup for draft facts (M3-T06). See 0010_draft_record_idempotency.sql.

import type { UUID } from "@backoffice/domain";
import type { Row } from "../rows";
import type { ServiceContext } from "../runtime";

/** Look up an existing draft row by its (organization_id, source_communication_id, fact_key) key. */
export async function findFactKeyRow(
  ctx: ServiceContext,
  table: string,
  sourceCommunicationId: UUID | undefined,
  factKey: string | undefined,
): Promise<Row | undefined> {
  if (sourceCommunicationId === undefined || factKey === undefined) return undefined;
  const { rows } = await ctx.tx.asService<Row>(
    `select * from ${table} where organization_id = $1 and source_communication_id = $2 and fact_key = $3`,
    [ctx.organizationId, sourceCommunicationId, factKey],
  );
  return rows[0];
}
