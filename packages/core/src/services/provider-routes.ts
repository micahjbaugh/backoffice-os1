// Owner-only management of the organization's phone numbers (M2-T18). Registering a route is
// audited automatically (0012: provider_routes_audit trigger) and, in the same transaction,
// re-queues any webhook events that arrived before the number was routed to this tenant
// (see ./webhooks.ts: requeueUnroutableWebhookEvents) so nothing is lost to ordering.

import {
  ConflictError,
  NotFoundError,
  parseInput,
  registerProviderRouteInput,
  type ProviderRoute,
  type RegisterProviderRouteInput,
  type UUID,
} from "@backoffice/domain";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "../db/types";
import { toProviderRoute, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { requeueUnroutableWebhookEvents } from "./webhooks";

export async function listProviderRoutes(ctx: ServiceContext): Promise<ProviderRoute[]> {
  await ctx.authorize("provider_route.manage");
  const { rows } = await ctx.tx.asService<Row>(
    `select * from public.provider_routes where organization_id = $1 order by created_at desc`,
    [ctx.organizationId],
  );
  return rows.map(toProviderRoute);
}

export interface RegisterProviderRouteResult {
  route: ProviderRoute;
  /** Previously unroutable webhook events for this address, now re-queued for processing. */
  requeuedEvents: number;
}

export async function registerProviderRoute(
  ctx: ServiceContext,
  input: RegisterProviderRouteInput,
): Promise<RegisterProviderRouteResult> {
  await ctx.authorize("provider_route.manage");
  const data = parseInput(registerProviderRouteInput, input);

  let route: ProviderRoute;
  try {
    const { rows } = await ctx.tx.asService<Row>(
      `insert into public.provider_routes (organization_id, provider, channel, address)
       values ($1, $2, $3, $4) returning *`,
      [ctx.organizationId, data.provider, data.channel, data.address],
    );
    route = toProviderRoute(rows[0] as Row);
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new ConflictError("address_already_routed", "That number is already registered.");
    }
    throw error;
  }

  const requeuedEvents = await requeueUnroutableWebhookEvents(ctx.tx, data.provider, data.address);
  return { route, requeuedEvents };
}

export async function deactivateProviderRoute(ctx: ServiceContext, routeId: UUID): Promise<void> {
  await ctx.authorize("provider_route.manage", {
    entityType: "provider_route",
    entityId: routeId,
  });
  const { rows } = await ctx.tx.asService<Row>(
    `update public.provider_routes set active = false
      where id = $1 and organization_id = $2 and active
      returning id`,
    [routeId, ctx.organizationId],
  );
  if (!rows[0]) throw new NotFoundError("active provider route", routeId);
}
