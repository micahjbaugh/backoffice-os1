import { actorLabel, actorUserId, type Actor, type UUID } from "@backoffice/domain";
import type { QueryResult, SqlExecutor } from "./types";

/**
 * A transaction with two execution modes:
 *
 * - `asUser`: runs as Postgres role `authenticated` with the actor's JWT claims, exactly like a
 *   Supabase client request. RLS applies, so tenant isolation is enforced by the database.
 * - `asService`: runs as the connection's owner role (bypasses RLS). Only for trusted writes
 *   (audit, events, decisions) *after* code-level authorization has passed.
 *
 * Both modes share one transaction, so "decision + event + audit" commit or roll back together.
 * All settings are transaction-local (`set_config(..., true)` / `SET LOCAL`), so nothing leaks
 * to the next user of a pooled connection.
 */
export class Tx {
  private mode: "service" | "user" = "service";

  private constructor(
    private readonly exec: SqlExecutor,
    readonly actor: Actor,
    readonly userId: UUID | null,
  ) {}

  static async begin(exec: SqlExecutor, actor: Actor): Promise<Tx> {
    const userId = actorUserId(actor);
    const claims = userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "";
    await exec.query(
      `select set_config('request.jwt.claims', $1, true),
              set_config('request.jwt.claim.sub', $2, true),
              set_config('app.actor_type', $3, true),
              set_config('app.actor_label', $4, true)`,
      [claims, userId ?? "", actor.type, actorLabel(actor)],
    );
    return new Tx(exec, actor, userId);
  }

  async asUser<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    if (!this.userId) {
      throw new Error(`asUser requires a human actor; got ${this.actor.type}`);
    }
    if (this.mode !== "user") {
      await this.exec.query("set local role authenticated");
      this.mode = "user";
    }
    return this.exec.query<R>(sql, params);
  }

  async asService<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    if (this.mode !== "service") {
      await this.exec.query("reset role");
      this.mode = "service";
    }
    return this.exec.query<R>(sql, params);
  }
}
