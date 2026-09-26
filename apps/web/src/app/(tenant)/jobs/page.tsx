import { listCustomers, listJobs } from "@backoffice/core";
import { JOB_STATUSES, roleHasPermission } from "@backoffice/domain";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { formatDateTime, humanize } from "@/lib/format";
import { withTenant } from "@/server/session";
import { createJobAction, updateJobStatusAction } from "../../actions/tenant";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const { jobs, customers, canWrite, tz } = await withTenant(async (ctx, session) => ({
    jobs: await listJobs(ctx),
    customers: await listCustomers(ctx),
    canWrite: roleHasPermission(session.role, "job.write"),
    tz: session.organization.timezone,
  }));

  return (
    <>
      <div className="page-head">
        <h1>Jobs</h1>
        <p>{jobs.length} jobs</p>
      </div>

      {canWrite ? (
        <section className="section card">
          <h2>New job</h2>
          <ActionForm action={createJobAction} className="grid-form">
            <label>
              Job name
              <input name="name" required maxLength={200} />
            </label>
            <label>
              Customer
              <select name="customerId" defaultValue="">
                <option value="">— none —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Scheduled start
              <input name="scheduledStart" type="datetime-local" />
            </label>
            <SubmitButton>Create job</SubmitButton>
          </ActionForm>
        </section>
      ) : null}

      <section className="section table-wrap">
        {jobs.length === 0 ? (
          <p className="empty">No jobs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Customer</th>
                <th>Scheduled</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.name}</td>
                  <td>{job.customerName ?? "—"}</td>
                  <td>{formatDateTime(job.scheduledStart, tz)}</td>
                  <td>
                    {canWrite ? (
                      <ActionForm
                        action={updateJobStatusAction}
                        className="row"
                        resetOnSuccess={false}
                      >
                        <input type="hidden" name="jobId" value={job.id} />
                        <select
                          key={job.status}
                          name="status"
                          defaultValue={job.status}
                          aria-label={`Status of ${job.name}`}
                        >
                          {JOB_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {humanize(s)}
                            </option>
                          ))}
                        </select>
                        <SubmitButton variant="secondary">Update</SubmitButton>
                      </ActionForm>
                    ) : (
                      humanize(job.status)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
