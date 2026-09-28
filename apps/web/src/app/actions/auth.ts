"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createOrganizationWithOwner, runAs } from "@backoffice/core";
import type { ActionState } from "@/lib/action-state";
import { field, runAction } from "@/server/actions";
import { db } from "@/server/db";
import { clientIp, enforceSignInRateLimit, RateLimitedError } from "@/server/rate-limit";
import { auth, ORG_COOKIE, ORG_COOKIE_OPTIONS, requireUser } from "@/server/session";

export async function signInAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const email = field(form, "email") ?? "";
  try {
    await enforceSignInRateLimit(clientIp(await headers()), email);
  } catch (error) {
    if (error instanceof RateLimitedError) return { ok: false, message: error.message };
    throw error;
  }
  const result = await auth.signInWithPassword(email, String(form.get("password") ?? ""));
  if (result.error) return { ok: false, message: result.error };
  redirect("/inbox");
}

export async function signUpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const password = String(form.get("password") ?? "");
  if (password.length < 10)
    return { ok: false, message: "Use a password of at least 10 characters." };
  const result = await auth.signUp(field(form, "email") ?? "", password);
  if (result.error) return { ok: false, message: result.error };
  if (result.needsConfirmation)
    return { ok: true, message: "Check your email to confirm your account." };
  redirect("/onboarding");
}

export async function signOutAction(): Promise<void> {
  await auth.signOut();
  (await cookies()).delete(ORG_COOKIE);
  redirect("/login");
}

export async function createOrganizationAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  let orgId: string | undefined;
  const state = await runAction(async () => {
    const org = await runAs(db(), { type: "user", userId: user.id }, (tx) =>
      createOrganizationWithOwner(tx, {
        name: field(form, "name") ?? "",
        slug: field(form, "slug"),
        timezone: field(form, "timezone") ?? "America/Chicago",
      }),
    );
    orgId = org.id;
  });
  if (!state?.ok || !orgId) return state;
  (await cookies()).set(ORG_COOKIE, orgId, ORG_COOKIE_OPTIONS);
  redirect("/inbox");
}
