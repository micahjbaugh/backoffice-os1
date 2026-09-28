import type {
  CreateSignedDownloadUrlRequest,
  DocumentStorageProvider,
  SignedDownloadUrl,
} from "../providers/document-storage-provider";

/** In-memory DocumentStorageProvider for tests and local development: records every request. */
export class FakeDocumentStorageProvider implements DocumentStorageProvider {
  private readonly requests: CreateSignedDownloadUrlRequest[] = [];
  private counter = 0;

  async createSignedDownloadUrl(
    request: CreateSignedDownloadUrlRequest,
  ): Promise<SignedDownloadUrl> {
    this.requests.push(request);
    return {
      url: `https://fake-storage.test/${request.bucket}/${request.path}?token=fake-${++this.counter}`,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000).toISOString(),
    };
  }

  get signedUrlRequests(): readonly CreateSignedDownloadUrlRequest[] {
    return this.requests;
  }
}
