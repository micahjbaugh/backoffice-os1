import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateSignedDownloadUrlRequest,
  DocumentStorageProvider,
  SignedDownloadUrl,
} from "../providers/document-storage-provider";

export interface SupabaseDocumentStorageConfig {
  supabaseUrl: string;
  /** Service-role key: required to sign a URL server-side without the caller's own session. */
  serviceRoleKey: string;
  fetchFn?: typeof fetch;
}

/** Real Supabase Storage adapter. The only place the Storage admin API is called (CLAUDE.md rule 9). */
export class SupabaseDocumentStorageProvider implements DocumentStorageProvider {
  private readonly client: SupabaseClient;

  constructor(config: SupabaseDocumentStorageConfig) {
    this.client = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: config.fetchFn ? { fetch: config.fetchFn } : undefined,
    });
  }

  async createSignedDownloadUrl(
    request: CreateSignedDownloadUrlRequest,
  ): Promise<SignedDownloadUrl> {
    const { data, error } = await this.client.storage
      .from(request.bucket)
      .createSignedUrl(request.path, request.expiresInSeconds);
    if (error || !data) {
      throw new Error(`supabase storage signed URL failed: ${error?.message ?? "no data"}`);
    }
    return {
      url: data.signedUrl,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000).toISOString(),
    };
  }
}
