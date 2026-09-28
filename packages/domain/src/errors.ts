import type { UUID } from "./types";

export type DomainErrorCode =
  "unauthenticated" | "forbidden" | "not_found" | "conflict" | "validation" | "rate_limited";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = "Authentication required") {
    super("unauthenticated", message);
  }
}

export interface ForbiddenDetails {
  action: string;
  reason: string;
  organizationId?: UUID | null;
  entityType?: string;
  entityId?: UUID;
}

/** Authorization failure. Carries enough context for the runtime to audit the denied attempt. */
export class ForbiddenError extends DomainError {
  readonly details: ForbiddenDetails;

  constructor(details: ForbiddenDetails) {
    super("forbidden", `Not permitted: ${details.action} (${details.reason})`);
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    super("not_found", id ? `${entity} ${id} not found` : `${entity} not found`);
  }
}

export class ConflictError extends DomainError {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super("conflict", message ?? reason);
    this.reason = reason;
  }
}

export class ValidationError extends DomainError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("validation", `Invalid input: ${issues.join("; ")}`);
    this.issues = issues;
  }
}

/** A caller exceeded a rate limit (webhook flood, sign-in brute force, server action abuse). */
export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterMs: number) {
    super("rate_limited", `Too many requests. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
