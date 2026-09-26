import "server-only";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { isDomainError, ValidationError } from "@backoffice/domain";
import type { ActionState } from "@/lib/action-state";

/**
 * Wrap a server action body: domain errors become user-facing messages, unexpected errors are
 * logged server-side and shown generically (no internals leak to the browser).
 */
export async function runAction(
  body: () => Promise<string | void>,
  revalidate: readonly string[] = [],
): Promise<ActionState> {
  try {
    const message = await body();
    for (const path of revalidate) revalidatePath(path);
    return { ok: true, message: message ?? "Saved." };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ValidationError) return { ok: false, message: error.issues.join("; ") };
    if (isDomainError(error)) {
      switch (error.code) {
        case "forbidden":
          return { ok: false, message: "You don't have permission to do that." };
        case "not_found":
          return { ok: false, message: "That record could not be found." };
        default:
          return { ok: false, message: error.message };
      }
    }
    console.error("server action failed", error);
    return { ok: false, message: "Something went wrong. Nothing was changed." };
  }
}

/** Read a trimmed form field; empty strings become undefined. */
export function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Dollars (as typed by a person) to integer cents. Rejects anything that isn't a plain amount. */
export function dollarsToCents(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized))
    throw new ValidationError(["amount must be a dollar amount"]);
  return Math.round(Number(normalized) * 100);
}

/**
 * HTML datetime-local value (no zone) -> ISO string. Interpreted in the *server's* time zone;
 * organization-timezone-aware input is a known M1 limitation.
 */
export function dateTimeLocalToIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(["invalid date"]);
  return date.toISOString();
}
