import { handleJobsRequest } from "@/server/jobs-endpoint";

export async function POST(request: Request): Promise<Response> {
  return handleJobsRequest(request);
}
