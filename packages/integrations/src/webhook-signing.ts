import { createHmac, timingSafeEqual } from "node:crypto";

/** Minimal header reader so callers can pass a Web `Headers` instance or a plain test double. */
export interface WebhookHeaders {
  get(name: string): string | null;
}

/** HMAC-SHA256 signature over the raw request body, hex-encoded. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time comparison against the expected signature. A missing, malformed, or mismatched
 * value fails closed (returns false) rather than throwing.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = signWebhookBody(secret, rawBody);
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
