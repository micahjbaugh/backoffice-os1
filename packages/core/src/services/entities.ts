import { NotFoundError, type EntityType, type UUID } from "@backoffice/domain";
import type { ServiceContext } from "../runtime";

const ENTITY_TABLES: Readonly<Record<EntityType, string>> = {
  customer: "public.customers",
  employee: "public.employees",
  vendor: "public.vendors",
  job: "public.jobs",
  task: "public.tasks",
  approval: "public.approvals",
  ops_case: "public.ops_cases",
  document: "public.documents",
  communication: "public.communications",
};

/**
 * Polymorphic references (entity_type/entity_id) have no FK, so a tenant could otherwise point a
 * record at another tenant's row. Verify the referenced entity lives in the caller's organization.
 */
export async function assertEntityInOrg(
  ctx: ServiceContext,
  entityType: EntityType | undefined,
  entityId: UUID | undefined,
): Promise<void> {
  if (entityType === undefined || entityId === undefined) return;
  const table = ENTITY_TABLES[entityType];
  const { rows } = await ctx.tx.asService(
    `select 1 from ${table} where id = $1 and organization_id = $2`,
    [entityId, ctx.organizationId],
  );
  if (rows.length === 0) throw new NotFoundError(entityType, entityId);
}

export async function assertUserIsMember(ctx: ServiceContext, userId: UUID): Promise<void> {
  const { rows } = await ctx.tx.asService(
    `select 1 from public.memberships where organization_id = $1 and user_id = $2`,
    [ctx.organizationId, userId],
  );
  if (rows.length === 0) throw new NotFoundError("member", userId);
}

/** communications has no entry in ENTITY_TABLES: it is a source reference, not a polymorphic ref. */
export async function assertCommunicationInOrg(
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
