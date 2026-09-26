import {
  createJobInput,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  updateJobInput,
  type CreateJobInput,
  type Job,
  type UpdateJobInput,
  type UUID,
} from "@backoffice/domain";
import { toJob, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

const JOB_SELECT = `select j.*, c.display_name as customer_name
                      from public.jobs j
                      left join public.customers c on c.id = j.customer_id`;

export async function listJobs(ctx: ServiceContext): Promise<Job[]> {
  await ctx.authorize("job.read");
  const { rows } = await ctx.scoped<Row>(
    `${JOB_SELECT} where j.organization_id = $1 order by j.created_at desc`,
    [ctx.organizationId],
  );
  return rows.map(toJob);
}

export async function getJob(ctx: ServiceContext, jobId: UUID): Promise<Job> {
  await ctx.authorize("job.read");
  const { rows } = await ctx.scoped<Row>(
    `${JOB_SELECT} where j.id = $1 and j.organization_id = $2`,
    [jobId, ctx.organizationId],
  );
  if (!rows[0]) throw new NotFoundError("job", jobId);
  return toJob(rows[0]);
}

export async function createJob(ctx: ServiceContext, input: CreateJobInput): Promise<Job> {
  await ctx.authorize("job.write");
  const data = parseInput(createJobInput, input);
  // Also enforced by the (customer_id, organization_id) composite FK.
  await assertEntityInOrg(ctx, data.customerId ? "customer" : undefined, data.customerId);
  const { rows } = await ctx.scoped<{ id: UUID }>(
    `insert into public.jobs (organization_id, customer_id, name, status, scheduled_start, scheduled_end)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      ctx.organizationId,
      data.customerId ?? null,
      data.name,
      data.status,
      data.scheduledStart ?? null,
      data.scheduledEnd ?? null,
    ],
  );
  const job = await getJob(ctx, (rows[0] as { id: UUID }).id);
  await recordEvent(ctx, {
    type: EVENT_TYPES.jobCreated,
    entityType: "job",
    entityId: job.id,
    payload: { name: job.name, status: job.status, customer_id: job.customerId },
  });
  return job;
}

export async function updateJob(
  ctx: ServiceContext,
  jobId: UUID,
  input: UpdateJobInput,
): Promise<Job> {
  await ctx.authorize("job.write", { entityType: "job", entityId: jobId });
  const data = parseInput(updateJobInput, input);
  const { rows } = await ctx.scoped<{ id: UUID }>(
    `update public.jobs
        set name = coalesce($3, name),
            status = coalesce($4, status)
      where id = $1 and organization_id = $2
      returning id`,
    [jobId, ctx.organizationId, data.name ?? null, data.status ?? null],
  );
  if (!rows[0]) throw new NotFoundError("job", jobId);
  const job = await getJob(ctx, jobId);
  await recordEvent(ctx, {
    type: EVENT_TYPES.jobUpdated,
    entityType: "job",
    entityId: job.id,
    payload: { name: data.name, status: data.status },
  });
  return job;
}
