import { listCustomers } from "@backoffice/core";
import { roleHasPermission } from "@backoffice/domain";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { PageNav } from "@/components/PageNav";
import { firstParam, type SearchParams } from "@/lib/pagination";
import { withTenant } from "@/server/session";
import { createCustomerAction } from "../../actions/tenant";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const cursor = firstParam(await searchParams, "cursor");
  const { customers, canWrite, nextCursor } = await withTenant(async (ctx, session) => {
    const page = await listCustomers(ctx, { cursor });
    return {
      customers: page.items,
      nextCursor: page.nextCursor,
      canWrite: roleHasPermission(session.role, "customer.write"),
    };
  });

  return (
    <>
      <div className="page-head">
        <h1>Customers</h1>
        <p>Showing {customers.length}</p>
      </div>

      {canWrite ? (
        <section className="section card">
          <h2>Add customer</h2>
          <ActionForm action={createCustomerAction} className="grid-form">
            <label>
              Name
              <input name="displayName" required maxLength={200} />
            </label>
            <label>
              Phone
              <input name="phone" type="tel" maxLength={32} />
            </label>
            <label>
              Email
              <input name="email" type="email" maxLength={320} />
            </label>
            <label>
              Notes
              <input name="notes" maxLength={4000} />
            </label>
            <SubmitButton>Add customer</SubmitButton>
          </ActionForm>
        </section>
      ) : null}

      <section className="section table-wrap">
        {customers.length === 0 ? (
          <p className="empty">No customers yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>{c.displayName}</td>
                  <td>{c.phone ?? "—"}</td>
                  <td>{c.email ?? "—"}</td>
                  <td>{c.notes ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PageNav basePath="/customers" cursor={cursor} nextCursor={nextCursor} />
      </section>
    </>
  );
}
