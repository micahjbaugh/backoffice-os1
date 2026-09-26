// How an outbound provider call ended, stated honestly.
//
// A provider request either definitely did not take effect (safe to retry if the reason is
// transient), definitely took effect (success), or MAY have taken effect (a timeout, a 5xx after the
// request was sent, a dropped connection). The last case must never be retried blindly: the outbox
// marks it `unknown` and reconciles or escalates to a person.

export type ProviderFailureKind =
  /** The provider refused the request; it did not take effect. */
  | "rejected"
  /** The request may or may not have taken effect. */
  | "ambiguous";

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderFailureKind,
    /** Only meaningful for "rejected": whether trying again later can succeed (e.g. 429). */
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/** Classify a non-2xx provider response. */
export function errorForResponse(
  provider: string,
  status: number,
  body: string,
): ProviderRequestError {
  const detail = `${provider} responded ${status}: ${body.slice(0, 300)}`;
  if (status === 429) return new ProviderRequestError(detail, "rejected", true, status);
  if (status === 408 || status >= 500)
    return new ProviderRequestError(detail, "ambiguous", false, status);
  return new ProviderRequestError(detail, "rejected", false, status);
}

// Connection never established, so the request never reached the provider. (ECONNRESET is NOT here:
// a reset can happen after the request was sent.)
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Classify a thrown fetch error (network failure, timeout, abort). */
export function errorForThrown(provider: string, error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: string } | null)?.code;
  const message = `${provider} request failed: ${error instanceof Error ? error.message : String(error)}`;
  // Could not even reach the provider: nothing was sent.
  if (code && NOT_SENT_CODES.has(code)) return new ProviderRequestError(message, "rejected", true);
  // Timeouts and mid-request failures: the provider may have acted.
  return new ProviderRequestError(message, "ambiguous", false);
}

/** fetch with a hard timeout; timeouts surface as ambiguous ProviderRequestErrors. */
export async function providerFetch(
  provider: string,
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw errorForThrown(provider, error);
  }
}
