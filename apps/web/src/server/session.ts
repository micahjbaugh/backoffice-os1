import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  getInternalStaff,
  inTenant,
  listMyOrganizations,
  runAs,
  type OrganizationWithRole,
  type ServiceContext,
  type Tx,
} from "@backoffice/core";
import type { InternalStaff, MembershipRole, Organization } from "@backoffice/domain";
import type { AuthProvider, AuthUser } from "./auth/provider";
import { supabaseAuth } from "./auth/supabase";
import { db } from "./db";

export const auth: AuthProvider = supabaseAuth;

/** Cookie holding the *preferred* organization. Never trusted: re-validated against memberships. */
export const ORG_COOKIE = "bo_org";
export const ORG_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

export const getCurrentUser = cache(async (): Promise<AuthUser | null> => auth.getUser());

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export interface UserSession {
  user: AuthUser;
  organizations: OrganizationWithRole[];
  staff: InternalStaff | null;
}

export const getUserSession = cache(async (): Promise<UserSession> => {
  const user = await requireUser();
  return runAs(db(), { type: "user", userId: user.id }, async (tx) => ({
    user,
    organizations: await listMyOrganizations(tx),
    staff: await getInternalStaff(tx, user.id),
  }));
});

export interface TenantSession extends UserSession {
  organization: Organization;
  role: MembershipRole;
}

export const getTenantSession = cache(async (): Promise<TenantSession> => {
  const session = await getUserSession();
  if (session.organizations.length === 0) redirect(session.staff ? "/ops/cases" : "/onboarding");
  const preferred = (await cookies()).get(ORG_COOKIE)?.value;
  const current =
    session.organizations.find((o) => o.organization.id === preferred) ?? session.organizations[0];
  if (!current) redirect("/onboarding");
  return { ...session, organization: current.organization, role: current.role };
});

/** Run tenant work as the signed-in user in their current organization (RLS-enforced). */
export async function withTenant<T>(
  fn: (ctx: ServiceContext, session: TenantSession) => Promise<T>,
): Promise<T> {
  const session = await getTenantSession();
  return runAs(db(), { type: "user", userId: session.user.id }, (tx) =>
    fn(inTenant(tx, session.organization.id), session),
  );
}

/** Ops Console gate: internal staff only. Others get a 404 so the console's existence isn't advertised. */
export async function requireOperator(): Promise<{ user: AuthUser; staff: InternalStaff }> {
  const session = await getUserSession();
  if (!session.staff) notFound();
  return { user: session.user, staff: session.staff };
}

/** Run Ops Console work as an internal operator. Tenant access additionally requires a live grant. */
export async function withOperator<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { user } = await requireOperator();
  return runAs(db(), { type: "internal_operator", userId: user.id }, fn);
}
