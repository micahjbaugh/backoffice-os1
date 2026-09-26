import Link from "next/link";
import { notFound } from "next/navigation";
import { openOpsCase } from "@backoffice/core";
import { ForbiddenError, NotFoundError, OPS_CASE_STATUSES } from "@backoffice/domain";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { formatDateTime, humanize } from "@/lib/format";
import { withOperator } from "@/server/session";
import { updateOpsCaseAction } from "../../../actions/ops";

export const dynamic = "force-dynamic";

async function loadCase(id: string) {
  try {
    // Requires internal staff + a live grant for the case's organization; the view is audited.
    return await withOperator((tx) => openOpsCase(tx, id));
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return null;
    throw error;
  }
}

export default async function OpsCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await loadCase(id);
  if (!detail) {
    return (
      <>
        <p>
          <Link href="/ops/cases">← Case queue</Link>
        </p>
        <h1>No access</h1>
        <p className="meta">
          This case doesn&apos;t exist or its organization hasn&apos;t granted you access. The
          attempt was logged.
        </p>
      </>
    );
  }
  const { opsCase, timeline } = detail;

  return (
    <>
      <p>
        <Link href="/ops/cases">← Case queue</Link>
      </p>
      <div className="page-head">
        <h1>{opsCase.title}</h1>
        <p>
          {opsCase.organizationName} · {humanize(opsCase.reasonCode)} · {opsCase.priority} priority
          · {humanize(opsCase.status)}
        </p>
      </div>

      <section className="section card">
        <h2>Evidence</h2>
        <pre className="evidence">{JSON.stringify(opsCase.evidence, null, 2)}</pre>
        {opsCase.entityType ? (
          <p className="meta">
            Related {opsCase.entityType}: {opsCase.entityId}
          </p>
        ) : null}
        {opsCase.resolution ? <p>Resolution: {opsCase.resolution}</p> : null}
      </section>

      <section className="section card">
        <h2>Work this case</h2>
        <ActionForm action={updateOpsCaseAction} className="stack" resetOnSuccess={false}>
          <input type="hidden" name="caseId" value={opsCase.id} />
          <label className="inline">
            <input
              type="checkbox"
              name="assignToSelf"
              defaultChecked={!opsCase.assignedOperatorUserId}
            />{" "}
            Assign to me
          </label>
          <label>
            Status
            <select name="status" defaultValue={opsCase.status}>
              {OPS_CASE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Resolution (required to resolve)
            <textarea name="resolution" maxLength={4000} defaultValue={opsCase.resolution ?? ""} />
          </label>
          <label>
            Automation gap category
            <input
              name="automationGapCategory"
              maxLength={64}
              defaultValue={opsCase.automationGapCategory ?? ""}
            />
          </label>
          <SubmitButton>Save</SubmitButton>
        </ActionForm>
      </section>

      <section className="section">
        <h2>Timeline</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Actor</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((e) => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.occurredAt)}</td>
                  <td>{e.type}</td>
                  <td>{humanize(e.actorType)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
