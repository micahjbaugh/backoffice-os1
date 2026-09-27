import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ProviderConfigError } from "@backoffice/integrations";
import { runBackgroundJobs } from "@backoffice/workflows";
import { db } from "./db";
import { providerRuntime } from "./providers";

const MIN_SECRET_LENGTH = 32;

function authorized(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header ?? "");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/**
 * Background jobs trigger (webhook processing, outbound dispatch, reconciliation). Call it from a
 * scheduler with `Authorization: Bearer $INTERNAL_JOBS_SECRET`. Disabled (503) until a strong secret
 * is configured; never reachable without it.
 */
export async function handleJobsRequest(request: Request): Promise<Response> {
  const secret = process.env.INTERNAL_JOBS_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return NextResponse.json({ error: "jobs endpoint not configured" }, { status: 503 });
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let runtime;
  try {
    runtime = providerRuntime();
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      console.error(`jobs: provider unavailable: ${error.message}`);
      return NextResponse.json({ error: "provider not configured" }, { status: 503 });
    }
    throw error;
  }
  const summary = await runBackgroundJobs(db(), runtime);
  return NextResponse.json(summary);
}
