import "server-only";

import { createPostgresRateLimiter, enforceRateLimit, type RateLimiter } from "@backoffice/core";
import { db } from "./db";

export { RateLimitedError } from "@backoffice/domain";

interface HeaderLike {
  get(name: string): string | null;
}

const globalForLimiter = globalThis as unknown as { backofficeRateLimiter?: RateLimiter };

function limiter(): RateLimiter {
  globalForLimiter.backofficeRateLimiter ??= createPostgresRateLimiter(db());
  return globalForLimiter.backofficeRateLimiter;
}

/** Client IP from the proxy headers our deployment target sets; "unknown" shares one bucket rather
 *  than throwing when a proxy is missing (e.g. local dev), so limiting still degrades safely. */
export function clientIp(headers: HeaderLike): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return headers.get("x-real-ip")?.trim() || "unknown";
}

// Providers share IP ranges across tenants, so this is a coarse flood guard, not a per-tenant
// budget: tenant identity for a webhook isn't known until after signature verification anyway.
// Generous on purpose so a legitimate retry storm from a provider still gets through.
const WEBHOOK_LIMIT = 300;
const WEBHOOK_WINDOW_MS = 60_000;

export async function enforceWebhookRateLimit(request: Request, provider: string): Promise<void> {
  await enforceRateLimit(
    limiter(),
    `webhook:${provider}:${clientIp(request.headers)}`,
    WEBHOOK_LIMIT,
    WEBHOOK_WINDOW_MS,
  );
}

// Two dimensions so one leaked/guessed address can't be brute-forced from many IPs, and one IP
// can't spray many addresses; both must pass.
const SIGNIN_IP_LIMIT = 20;
const SIGNIN_EMAIL_LIMIT = 8;
const SIGNIN_WINDOW_MS = 5 * 60_000;

export async function enforceSignInRateLimit(ip: string, email: string): Promise<void> {
  await enforceRateLimit(limiter(), `signin:ip:${ip}`, SIGNIN_IP_LIMIT, SIGNIN_WINDOW_MS);
  await enforceRateLimit(
    limiter(),
    `signin:email:${email.trim().toLowerCase()}`,
    SIGNIN_EMAIL_LIMIT,
    SIGNIN_WINDOW_MS,
  );
}

// Authenticated server actions: scoped to the tenant (or operator) already established by
// withTenant/withOperator, so a compromised or scripted account can't hammer the domain layer.
const SERVER_ACTION_LIMIT = 60;
const SERVER_ACTION_WINDOW_MS = 60_000;

export async function enforceServerActionRateLimit(scopeKey: string): Promise<void> {
  await enforceRateLimit(
    limiter(),
    `action:${scopeKey}`,
    SERVER_ACTION_LIMIT,
    SERVER_ACTION_WINDOW_MS,
  );
}
