import Link from "next/link";
import { listOperatorCases } from "@backoffice/core";
import { PageNav } from "@/components/PageNav";
import { formatDateTime, humanize } from "@/lib/format";
import { firstParam, type SearchParams } from "@/lib/pagination";
import { withOperator } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OpsCasesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const cursor = firstParam(await searchParams, "cursor");
  const { items: cases, nextCursor } = await withOperator((tx) =>
    listOperatorCases(tx, { page: { cursor } }),
  );
  return (
    <>
      <div className="page-head">
        <h1>Case queue</h1>
        <p>
          Open cases in organizations that have granted you access. Opening a case is logged to that
          organization.
        </p>
      </div>
      {cases.length === 0 ? (
        <p className="empty">
          No cases visible. Tenants must grant you access before their cases appear here.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Organization</th>
                <th>Reason</th>
                <th>Priority</th>
                <th>Status</th>
                <th>SLA</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/ops/cases/${c.id}`}>{c.title}</Link>
                  </td>
                  <td>{c.organizationName}</td>
                  <td>{humanize(c.reasonCode)}</td>
                  <td>
                    <span
                      className={`badge ${c.priority === "urgent" ? "red" : c.priority === "high" ? "yellow" : ""}`}
                    >
                      {c.priority}
                    </span>
                  </td>
                  <td>{humanize(c.status)}</td>
                  <td>{formatDateTime(c.slaDueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PageNav basePath="/ops/cases" cursor={cursor} nextCursor={nextCursor} />
    </>
  );
}
