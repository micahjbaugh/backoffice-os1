"use client";

// Client wrapper for server-action forms: disables the submit button while pending (first line of
// double-submit defense; the server is idempotent regardless) and shows the action's result.
// Must never import from @/server or @backoffice/core.

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action-state";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = true,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className={className}
      key={resetOnSuccess && state?.ok ? state.message : undefined}
    >
      {children}
      {state?.message ? (
        <p
          className={state.ok ? "form-result ok" : "form-result error"}
          role={state.ok ? "status" : "alert"}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function SubmitButton({
  children,
  variant = "primary",
  name,
  value,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn ${variant}`} disabled={pending} name={name} value={value}>
      {pending ? "Working…" : children}
    </button>
  );
}
