import { listVendors } from "@backoffice/core";
import { roleHasPermission } from "@backoffice/domain";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { PageNav } from "@/components/PageNav";
import { firstParam, type SearchParams } from "@/lib/pagination";
import { withTenant } from "@/server/session";
import { createVendorAction } from "../../actions/tenant";

export const dynamic = "force-dynamic";

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const cursor = firstParam(await searchParams, "cursor");
  const { vendors, canWrite, nextCursor } = await withTenant(async (ctx, session) => {
    const page = await listVendors(ctx, { cursor });
    return {
      vendors: page.items,
      nextCursor: page.nextCursor,
      canWrite: roleHasPermission(session.role, "vendor.write"),
    };
  });

  return (
    <>
      <div className="page-head">
        <h1>Vendors</h1>
        <p>Showing {vendors.length}</p>
      </div>

      {canWrite ? (
        <section className="section card">
          <h2>Add vendor</h2>
          <ActionForm action={createVendorAction} className="grid-form">
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
            <label className="inline">
              <input name="preferred" type="checkbox" /> Preferred
            </label>
            <SubmitButton>Add vendor</SubmitButton>
          </ActionForm>
        </section>
      ) : null}

      <section className="section table-wrap">
        {vendors.length === 0 ? (
          <p className="empty">No vendors yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id}>
                  <td>{v.displayName}</td>
                  <td>{v.phone ?? "—"}</td>
                  <td>{v.email ?? "—"}</td>
                  <td>
                    {v.preferred ? <span className="badge ok">preferred</span> : null}
                    {v.approved ? (
                      <span className="badge">approved</span>
                    ) : (
                      <span className="badge red">not approved</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PageNav basePath="/vendors" cursor={cursor} nextCursor={nextCursor} />
      </section>
    </>
  );
}
