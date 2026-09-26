import Link from "next/link";
import type { ReactNode } from "react";
import { humanize } from "@/lib/format";
import { getTenantSession } from "@/server/session";
import { signOutAction } from "../actions/auth";
import { selectOrganizationAction } from "../actions/tenant";

export const dynamic = "force-dynamic";

export default async function TenantLayout({ children }: { children: ReactNode }) {
  const session = await getTenantSession();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Back Office OS
          <small>{session.organization.name}</small>
        </div>
        {session.organizations.length > 1 ? (
          <form action={selectOrganizationAction} className="row">
            <select
              name="organizationId"
              defaultValue={session.organization.id}
              aria-label="Organization"
            >
              {session.organizations.map(({ organization }) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
            <button className="btn secondary" type="submit">
              Switch
            </button>
          </form>
        ) : null}
        <nav className="nav">
          <Link href="/inbox">Inbox</Link>
          <Link href="/customers">Customers</Link>
          <Link href="/jobs">Jobs</Link>
          <Link href="/vendors">Vendors</Link>
          <Link href="/settings">Settings</Link>
          {session.staff ? <Link href="/ops/cases">Ops Console</Link> : null}
        </nav>
        <div className="sidebar-footer">
          <span>
            {session.user.email}
            <br />
            {humanize(session.role)}
          </span>
          <form action={signOutAction}>
            <button className="btn link" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
