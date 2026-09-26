import { listCustomers } from "@backoffice/core";
import { roleHasPermission } from "@backoffice/domain";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { withTenant } from "@/server/session";
import { createCustomerAction } from "../../actions/tenant";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const { customers, canWrite } = await withTenant(async (ctx, session) => ({
    customers: await listCustomers(ctx),
    canWrite: roleHasPermission(session.role, "customer.write"),
  }));

  return (
    <>
      <div className="page-head">
        <h1>Customers</h1>
        <p>{customers.length} on file</p>
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
      </section>
    </>
  );
}
