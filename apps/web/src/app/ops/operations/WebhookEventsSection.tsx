import type { OperatorWebhookEvent, WebhookEvent } from "@backoffice/core";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { formatDateTime } from "@/lib/format";
import { webhookEventAction } from "../../actions/ops-operations";

export function WebhookEventsSection({
  dead,
  unrouted,
}: {
  dead: OperatorWebhookEvent[];
  unrouted: WebhookEvent[];
}) {
  return (
    <section className="section">
      <h2>Dead webhook events</h2>
      <p className="meta">
        Delivery failed until it was given up on. Retry is safe: the handler never finished, and
        handlers are idempotent.
      </p>
      {dead.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Event</th>
                <th>Organization</th>
                <th>Received</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {dead.map((e) => (
                <tr key={e.id}>
                  <td>{e.provider}</td>
                  <td>{e.eventType ?? e.eventKey}</td>
                  <td>{e.organizationName}</td>
                  <td>{formatDateTime(e.receivedAt)}</td>
                  <td>{e.attempts}</td>
                  <td className="meta">{e.lastError ?? "—"}</td>
                  <td>
                    <ActionForm action={webhookEventAction} className="row">
                      <input type="hidden" name="eventId" value={e.id} />
                      <SubmitButton name="intent" value="retry">
                        Retry
                      </SubmitButton>
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

      <h2>Unrouted webhook events</h2>
      <p className="meta">
        No organization could be resolved yet. Nothing to grant access to, so these cannot be
        retried or cancelled from here; they need a provider route fix.
      </p>
      {unrouted.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Event</th>
                <th>Received</th>
                <th>Status</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {unrouted.map((e) => (
                <tr key={e.id}>
                  <td>{e.provider}</td>
                  <td>{e.eventType ?? e.eventKey}</td>
                  <td>{formatDateTime(e.receivedAt)}</td>
                  <td>{e.status}</td>
                  <td className="meta">{e.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
