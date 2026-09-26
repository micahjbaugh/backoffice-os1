import {
  actorHasPermission,
  actorLabel,
  actorUserId,
  ForbiddenError,
  type Actor,
  type MembershipRole,
  type Permission,
  type UUID,
} from "@backoffice/domain";
import { Tx } from "./db/tx";
import {
  PG_INSUFFICIENT_PRIVILEGE,
  pgErrorCode,
  type Database,
  type QueryResult,
} from "./db/types";

/**
 * Execute `fn` in one transaction on behalf of `actor`.
 *
 * - Authorization denials (ForbiddenError) are audited in a separate transaction after rollback,
 *   so a denied attempt leaves a trace even though its own work was discarded.
 * - A database privilege/RLS rejection means code-level authorization missed something; it is
 *   surfaced as a ForbiddenError (and audited) rather than a raw driver error.
 */
export async function runAs<T>(db: Database, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (exec) => fn(await Tx.begin(exec, actor)));
  } catch (error) {
    const denial =
      error instanceof ForbiddenError
        ? error
        : pgErrorCode(error) === PG_INSUFFICIENT_PRIVILEGE
          ? new ForbiddenError({ action: "database_operation", reason: "database_denied" })
          : null;
    if (denial) {
      await auditDenial(db, actor, denial);
      throw denial;
    }
    throw error;
  }
}

async function auditDenial(db: Database, actor: Actor, denial: ForbiddenError): Promise<void> {
  const { action, reason, organizationId, entityType, entityId } = denial.details;
  try {
    await db.transaction(async (exec) => {
      await exec.query(
        `insert into public.audit_log (organization_id, actor_type, actor_id, action, entity_type, entity_id, details)
         values ((select id from public.organizations where id = $1), $2, $3, 'authz.denied', $4, $5, $6)`,
        [
          organizationId ?? null,
          actor.type,
          actorUserId(actor),
          entityType ?? null,
          entityId ?? null,
          { attempted_action: action, reason, actor_label: actorLabel(actor) },
        ],
      );
    });
  } catch (auditError) {
    console.error("failed to audit authorization denial", auditError);
  }
}

/** Tenant-scoped execution context passed to every Business Brain service. */
export class ServiceContext {
  private roleLookup: Promise<MembershipRole | null> | undefined;

  constructor(
    readonly tx: Tx,
    readonly organizationId: UUID,
  ) {}

  get actor(): Actor {
    return this.tx.actor;
  }

  /** The acting user's membership role in this organization (null for non-members/non-users). */
  role(): Promise<MembershipRole | null> {
    this.roleLookup ??= (async () => {
      if (this.actor.type !== "user") return null;
      const { rows } = await this.tx.asService<{ role: MembershipRole }>(
        `select role from public.memberships where organization_id = $1 and user_id = $2`,
        [this.organizationId, this.actor.userId],
      );
      return rows[0]?.role ?? null;
    })();
    return this.roleLookup;
  }

  /** Throw ForbiddenError unless the actor holds `permission` in this organization. */
  async authorize(
    permission: Permission,
    entity?: { entityType: string; entityId: UUID },
  ): Promise<MembershipRole | null> {
    const role = await this.role();
    if (!actorHasPermission(this.actor, role, permission)) {
      throw new ForbiddenError({
        action: permission,
        reason:
          this.actor.type === "user"
            ? role
              ? `role:${role}`
              : "not_a_member"
            : `actor:${this.actor.type}`,
        organizationId: this.organizationId,
        ...entity,
      });
    }
    return role;
  }

  /**
   * Query tenant records in the actor's own security context: humans go through RLS as
   * `authenticated`; trusted non-human actors (already authorized in code) run as service.
   */
  scoped<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.actor.type === "user"
      ? this.tx.asUser<R>(sql, params)
      : this.tx.asService<R>(sql, params);
  }
}

export function inTenant(tx: Tx, organizationId: UUID): ServiceContext {
  return new ServiceContext(tx, organizationId);
}
