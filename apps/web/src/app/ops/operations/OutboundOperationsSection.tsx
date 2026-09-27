import type { OperatorOutboundOperation } from "@backoffice/core";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { humanize } from "@/lib/format";
import { outboundOperationAction } from "../../actions/ops-operations";

export function OutboundOperationsSection({
  operations,
}: {
  operations: OperatorOutboundOperation[];
}) {
  return (
    <section className="section">
      <h2>Failed &amp; unknown outbound operations</h2>
      <p className="meta">
        Failed operations never reached the provider (or the provider rejected them) and can be
        retried. Unknown operations may already have happened — they can only be resolved by
        reconciling with the provider first, never retried directly.
      </p>
      {operations.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Organization</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => (
                <tr key={op.id}>
                  <td>{humanize(op.operationType)}</td>
                  <td>{op.organizationName}</td>
                  <td>
                    <span className={`badge ${op.status === "unknown" ? "yellow" : "red"}`}>
                      {op.status}
                    </span>
                  </td>
                  <td>{op.attempts}</td>
                  <td className="meta">{op.lastError ?? "—"}</td>
                  <td>
                    <ActionForm action={outboundOperationAction} className="row">
                      <input type="hidden" name="operationId" value={op.id} />
                      {op.status === "failed" ? (
                        <SubmitButton name="intent" value="retry">
                          Retry
                        </SubmitButton>
                      ) : (
                        <>
                          <SubmitButton name="intent" value="reconcile_succeeded">
                            Reconcile: happened
                          </SubmitButton>
                          <SubmitButton name="intent" value="reconcile_did_not_happen">
                            Reconcile: didn&apos;t happen
                          </SubmitButton>
                        </>
                      )}
                      <SubmitButton name="intent" value="cancel" variant="danger">
                        Cancel
                      </SubmitButton>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
