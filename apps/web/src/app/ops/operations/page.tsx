import { listStuckOutboundOperations, listStuckWebhookEvents } from "@backoffice/core";
import { withOperator } from "@/server/session";
import { OutboundOperationsSection } from "./OutboundOperationsSection";
import { WebhookEventsSection } from "./WebhookEventsSection";

export const dynamic = "force-dynamic";

export default async function OpsOperationsPage() {
  const [{ dead, unrouted }, operations] = await withOperator(async (tx) => [
    await listStuckWebhookEvents(tx),
    await listStuckOutboundOperations(tx),
  ]);

  return (
    <>
      <div className="page-head">
        <h1>Stuck operations</h1>
        <p>
          Webhook events and outbound operations that need a person, scoped to organizations that
          have granted you access. Every action here is audited to that organization.
        </p>
      </div>
      <WebhookEventsSection dead={dead} unrouted={unrouted} />
      <OutboundOperationsSection operations={operations} />
    </>
  );
}
