import {
  listAudit,
  listEmployees,
  listMembers,
  listOperatorGrants,
  listOrgOpsCases,
  listRules,
} from "@backoffice/core";
import { MEMBERSHIP_ROLES, roleHasPermission, type Permission } from "@backoffice/domain";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { formatDateTime, formatMoney, humanize } from "@/lib/format";
import { withTenant } from "@/server/session";
import {
  addMemberAction,
  createApprovalRuleAction,
  createEmployeeAction,
  grantOperatorAction,
  retireRuleAction,
  revokeOperatorAction,
} from "../../actions/tenant";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const d = await withTenant(async (ctx, session) => {
    const can = (p: Permission) => roleHasPermission(session.role, p);
    return {
      session,
      can: {
        manageMembers: can("member.manage"),
        writeEmployees: can("employee.write"),
        readRules: can("rule.read"),
        writeRules: can("rule.write"),
        manageGrants: can("operator_grant.manage"),
        readAudit: can("audit.read"),
        readOps: can("ops_case.read"),
      },
      members: can("member.read") ? await listMembers(ctx) : [],
      employees: await listEmployees(ctx),
      rules: can("rule.read") ? await listRules(ctx) : [],
      grants: can("operator_grant.manage") ? await listOperatorGrants(ctx) : [],
      audit: can("audit.read") ? await listAudit(ctx, 25) : [],
      opsCases: can("ops_case.read") ? await listOrgOpsCases(ctx) : [],
    };
  });
  const tz = d.session.organization.timezone;

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p>
          {d.session.organization.name} · {tz}
        </p>
      </div>

      <section className="section">
        <h2>Crew &amp; staff directory</h2>
        {d.can.writeEmployees ? (
          <div className="card">
            <ActionForm action={createEmployeeAction} className="grid-form">
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
              <SubmitButton>Add employee</SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        {d.employees.length === 0 ? (
          <p className="empty">No employees yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {d.employees.map((e) => (
                  <tr key={e.id}>
                    <td>{e.displayName}</td>
                    <td>{e.phone ?? "—"}</td>
                    <td>{e.email ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <h2>App users</h2>
        {d.can.manageMembers ? (
          <div className="card">
            <p className="meta">The person must already have a Back Office OS account.</p>
            <ActionForm action={addMemberAction} className="grid-form">
              <label>
                Email
                <input name="email" type="email" required />
              </label>
              <label>
                Role
                <select name="role" defaultValue="field_employee">
                  {MEMBERSHIP_ROLES.filter((r) => r !== "owner").map((r) => (
                    <option key={r} value={r}>
                      {humanize(r)}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton>Add user</SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {d.members.map((m) => (
                <tr key={m.id}>
                  <td>{m.email ?? m.userId}</td>
                  <td>{humanize(m.role)}</td>
                  <td>{formatDateTime(m.createdAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.can.readRules ? (
        <section className="section">
          <h2>Approval rules</h2>
          <p className="meta">
            By default the owner decides every financial approval. A rule can let office admins
            decide specific approval types up to a limit. High-risk approvals always go to the
            owner.
          </p>
          {d.can.writeRules ? (
            <div className="card">
              <ActionForm action={createApprovalRuleAction} className="grid-form">
                <label>
                  Rule name
                  <input
                    name="ruleKey"
                    required
                    pattern="[a-z0-9_.\-]+"
                    placeholder="admin-purchases"
                  />
                </label>
                <label>
                  Approval types (comma separated)
                  <input name="approvalTypes" placeholder="purchase" />
                </label>
                <label>
                  Up to ($)
                  <input name="maxAmount" inputMode="decimal" placeholder="500" />
                </label>
                <SubmitButton>Save rule for office admins</SubmitButton>
              </ActionForm>
            </div>
          ) : null}
          {d.rules.length === 0 ? (
            <p className="empty">No rules — defaults apply.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Version</th>
                    <th>Definition</th>
                    <th>Effective</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.rules.map((r) => {
                    const def = r.definition as {
                      approval_types?: string[];
                      roles?: string[];
                      max_amount_cents?: number;
                    };
                    const active = r.effectiveTo === null;
                    return (
                      <tr key={r.id}>
                        <td>{r.ruleKey}</td>
                        <td>v{r.version}</td>
                        <td>
                          {(def.roles ?? []).map(humanize).join(", ")} may decide{" "}
                          {def.approval_types?.join(", ") ?? "any type"}
                          {def.max_amount_cents !== undefined
                            ? ` up to ${formatMoney(def.max_amount_cents)}`
                            : ""}
                        </td>
                        <td>
                          {formatDateTime(r.effectiveFrom, tz)}
                          {active ? (
                            <span className="badge ok">active</span>
                          ) : (
                            ` → ${formatDateTime(r.effectiveTo, tz)}`
                          )}
                        </td>
                        <td>
                          {active && d.can.writeRules ? (
                            <ActionForm action={retireRuleAction}>
                              <input type="hidden" name="ruleId" value={r.id} />
                              <SubmitButton variant="danger">Retire</SubmitButton>
                            </ActionForm>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {d.can.manageGrants ? (
        <section className="section">
          <h2>Back Office team access</h2>
          <p className="meta">
            Our operators can only open your escalated cases while you have granted access. Every
            view is logged.
          </p>
          <div className="card">
            <ActionForm action={grantOperatorAction} className="grid-form">
              <label>
                Operator email
                <input name="operatorEmail" type="email" required />
              </label>
              <label>
                Reason
                <input name="reason" required minLength={5} maxLength={500} />
              </label>
              <label>
                For
                <select name="durationHours" defaultValue="24">
                  <option value="4">4 hours</option>
                  <option value="24">1 day</option>
                  <option value="72">3 days</option>
                  <option value="168">7 days</option>
                </select>
              </label>
              <SubmitButton>Grant access</SubmitButton>
            </ActionForm>
          </div>
          {d.grants.length === 0 ? null : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Operator</th>
                    <th>Reason</th>
                    <th>Expires</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.grants.map((g) => {
                    const live = g.active;
                    return (
                      <tr key={g.id}>
                        <td>{g.operatorEmail ?? g.operatorUserId}</td>
                        <td>{g.reason}</td>
                        <td>{formatDateTime(g.expiresAt, tz)}</td>
                        <td>
                          {live ? (
                            <span className="badge ok">active</span>
                          ) : (
                            <span className="badge">{g.revokedAt ? "revoked" : "expired"}</span>
                          )}
                        </td>
                        <td>
                          {live ? (
                            <ActionForm action={revokeOperatorAction}>
                              <input type="hidden" name="grantId" value={g.id} />
                              <SubmitButton variant="danger">Revoke</SubmitButton>
                            </ActionForm>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {d.can.readOps ? (
        <section className="section">
          <h2>Escalations to the Back Office team</h2>
          {d.opsCases.length === 0 ? (
            <p className="empty">None.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {d.opsCases.map((c) => (
                    <tr key={c.id}>
                      <td>{c.title}</td>
                      <td>{humanize(c.reasonCode)}</td>
                      <td>{humanize(c.status)}</td>
                      <td>{formatDateTime(c.createdAt, tz)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {d.can.readAudit ? (
        <section className="section">
          <h2>Recent activity (audit log)</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {d.audit.map((a) => (
                  <tr key={a.id}>
                    <td>{formatDateTime(a.createdAt, tz)}</td>
                    <td>
                      {humanize(a.actorType)}
                      {typeof a.details.actor_label === "string" && a.actorType !== "user"
                        ? ` (${a.details.actor_label})`
                        : ""}
                    </td>
                    <td>{a.action}</td>
                    <td>{a.entityType ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
