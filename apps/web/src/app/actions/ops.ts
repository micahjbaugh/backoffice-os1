"use server";

import { updateOpsCaseAsOperator } from "@backoffice/core";
import type { ActionState } from "@/lib/action-state";
import { field, runAction } from "@/server/actions";
import { withOperator } from "@/server/session";

export async function updateOpsCaseAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const caseId = field(form, "caseId") ?? "";
  return runAction(async () => {
    await withOperator((tx) =>
      updateOpsCaseAsOperator(tx, caseId, {
        status: field(form, "status") as "assigned" | undefined,
        resolution: field(form, "resolution"),
        automationGapCategory: field(form, "automationGapCategory"),
        assignToSelf: form.get("assignToSelf") === "on",
      }),
    );
    return "Case updated.";
  }, ["/ops/cases", `/ops/cases/${caseId}`]);
}
