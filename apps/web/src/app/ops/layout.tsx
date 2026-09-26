import Link from "next/link";
import type { ReactNode } from "react";
import { humanize } from "@/lib/format";
import { getUserSession, requireOperator } from "@/server/session";
import { signOutAction } from "../actions/auth";

export const dynamic = "force-dynamic";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const { user, staff } = await requireOperator();
  const { organizations } = await getUserSession();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Ops Console
          <small>Back Office OS internal</small>
        </div>
        <nav className="nav">
          <Link href="/ops/cases">Case queue</Link>
          {organizations.length > 0 ? <Link href="/inbox">My organization</Link> : null}
        </nav>
        <div className="sidebar-footer">
          <span>
            {user.email}
            <br />
            {humanize(staff.role)}
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
