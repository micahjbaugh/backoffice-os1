import {
  addMemberInput,
  ConflictError,
  createOrganizationInput,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  type AddMemberInput,
  type CreateOrganizationInput,
  type Membership,
  type MembershipRole,
  type Organization,
  type UUID,
} from "@backoffice/domain";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "../db/types";
import type { Tx } from "../db/tx";
import { toMembership, toOrganization, type Row } from "../rows";
import { inTenant, type ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { recordEvent } from "./events";

/** Onboarding: a signed-in user creates an organization and becomes its owner. */
export async function createOrganizationWithOwner(
  tx: Tx,
  input: CreateOrganizationInput,
): Promise<Organization> {
  if (tx.actor.type !== "user") throw new Error("organizations are created by a signed-in user");
  const userId = tx.actor.userId;
  const data = parseInput(createOrganizationInput, input);

  let org: Organization;
  try {
    const { rows } = await tx.asService<Row>(
      `insert into public.organizations (name, slug, timezone) values ($1, $2, $3) returning *`,
      [data.name, data.slug ?? null, data.timezone],
    );
    org = toOrganization(rows[0] as Row);
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new ConflictError("slug_taken");
    throw error;
  }

  await tx.asService(
    `insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')`,
    [org.id, userId],
  );
  const ctx = inTenant(tx, org.id);
  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.organizationCreated,
    entityType: "organization",
    entityId: org.id,
    payload: { name: org.name, owner_user_id: userId },
  });
  await writeAudit(ctx, {
    action: "organization.created",
    entityType: "organization",
    entityId: org.id,
    sourceEventId: event.id,
    details: { owner_user_id: userId },
  });
  return org;
}

export interface OrganizationWithRole {
  organization: Organization;
  role: MembershipRole;
}

/** Organizations the signed-in user belongs to, read through RLS. */
export async function listMyOrganizations(tx: Tx): Promise<OrganizationWithRole[]> {
  const { rows } = await tx.asUser<Row>(
    `select o.*, m.role
       from public.memberships m
       join public.organizations o on o.id = m.organization_id
      where m.user_id = auth.uid()
      order by o.name`,
  );
  return rows.map((r) => ({ organization: toOrganization(r), role: r.role as MembershipRole }));
}

export async function getOrganization(ctx: ServiceContext): Promise<Organization> {
  await ctx.authorize("org.read");
  const { rows } = await ctx.scoped<Row>(`select * from public.organizations where id = $1`, [
    ctx.organizationId,
  ]);
  if (!rows[0]) throw new NotFoundError("organization", ctx.organizationId);
  return toOrganization(rows[0]);
}

export async function listMembers(ctx: ServiceContext): Promise<Membership[]> {
  await ctx.authorize("member.read");
  // Emails live in auth.users, which clients cannot read; authorized above, filtered by org here.
  const { rows } = await ctx.tx.asService<Row>(
    `select m.*, u.email
       from public.memberships m
       left join auth.users u on u.id = m.user_id
      where m.organization_id = $1
      order by m.created_at`,
    [ctx.organizationId],
  );
  return rows.map(toMembership);
}

/** Owner adds an existing Back Office OS user to the organization with a non-owner role. */
export async function addMember(ctx: ServiceContext, input: AddMemberInput): Promise<Membership> {
  await ctx.authorize("member.manage");
  const data = parseInput(addMemberInput, input);
  const user = await ctx.tx.asService<{ id: UUID }>(
    `select id from auth.users where lower(email) = $1`,
    [data.email],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new NotFoundError("user with that email");

  const inserted = await ctx.tx.asService<Row>(
    `insert into public.memberships (organization_id, user_id, role) values ($1, $2, $3)
     on conflict (organization_id, user_id) do nothing
     returning *`,
    [ctx.organizationId, userId, data.role],
  );
  const row = inserted.rows[0];
  if (!row) throw new ConflictError("already_member");
  const membership = toMembership({ ...row, email: data.email });

  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.memberAdded,
    entityType: "membership",
    entityId: membership.id,
    payload: { user_id: userId, role: data.role },
  });
  await writeAudit(ctx, {
    action: "membership.created",
    entityType: "membership",
    entityId: membership.id,
    sourceEventId: event.id,
    details: { user_id: userId, role: data.role },
  });
  return membership;
}
