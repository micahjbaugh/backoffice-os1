"use server";

import {
  cancelDeadWebhookEvent,
  cancelOutboundOperation,
  reconcileUnknownOutboundOperation,
  retryDeadWebhookEvent,
  retryFailedOutboundOperation,
} from "@backoffice/core";
import type { ActionState } from "@/lib/action-state";
import { field, runAction } from "@/server/actions";
import { withOperator } from "@/server/session";

const REVALIDATE = ["/ops/operations"] as const;

export async function webhookEventAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = field(form, "eventId") ?? "";
  const intent = field(form, "intent");
  return runAction(async () => {
    if (intent === "cancel") {
      await withOperator((tx) => cancelDeadWebhookEvent(tx, id));
      return "Webhook event cancelled.";
    }
    await withOperator((tx) => retryDeadWebhookEvent(tx, id));
    return "Webhook event queued for retry.";
  }, REVALIDATE);
}

export async function outboundOperationAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = field(form, "operationId") ?? "";
  const intent = field(form, "intent");
  return runAction(async () => {
    switch (intent) {
      case "cancel":
        await withOperator((tx) => cancelOutboundOperation(tx, id));
        return "Outbound operation cancelled.";
      case "reconcile_succeeded":
        await withOperator((tx) =>
          reconcileUnknownOutboundOperation(tx, id, {
            kind: "succeeded",
            providerRef: field(form, "providerRef") ?? null,
          }),
        );
        return "Reconciled: the provider confirmed it happened.";
      case "reconcile_did_not_happen":
        await withOperator((tx) =>
          reconcileUnknownOutboundOperation(tx, id, { kind: "did_not_happen" }),
        );
        return "Reconciled: the provider confirmed it did not happen.";
      default:
        await withOperator((tx) => retryFailedOutboundOperation(tx, id));
        return "Outbound operation queued for retry.";
    }
  }, REVALIDATE);
}
