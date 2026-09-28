export interface CreateSignedDownloadUrlRequest {
  bucket: string;
  /** Storage object path, e.g. "<organization id>/<document id>/<file name>". */
  path: string;
  expiresInSeconds: number;
}

export interface SignedDownloadUrl {
  url: string;
  /** ISO timestamp; informational only — the provider itself enforces the actual expiry. */
  expiresAt: string;
}

/**
 * Mints time-limited download links for private object storage (PH-T03). Signing happens with a
 * trusted server credential (the storage service's own admin key, not the caller's session), so
 * every call site must have already run its own authorization check and audit write — this
 * interface has no notion of who is asking, only what to sign.
 */
export interface DocumentStorageProvider {
  createSignedDownloadUrl(request: CreateSignedDownloadUrlRequest): Promise<SignedDownloadUrl>;
}
