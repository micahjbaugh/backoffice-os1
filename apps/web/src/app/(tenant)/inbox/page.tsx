import { randomUUID } from "node:crypto";
import {
  BILLABLE_OPPORTUNITY_POLICY_SUBJECT,
  listNotes,
  listOpenBillableOpportunities,
  listOpenTasks,
  listOrgOpsCases,
  listPendingApprovals,
  loadApprovalDelegationRules,
} from "@backoffice/core";
import {
  evaluateApprovalDecision,
  OPS_CASE_REASON_CODES,
  PRIORITIES,
  roleHasPermission,
  type Approval,
  type BillableOpportunity,
  type DecisionAuthority,
  type Note,
  type OpsCase,
} from "@backoffice/domain";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { PageNav } from "@/components/PageNav";
import { formatDateTime, formatMoney, humanize } from "@/lib/format";
import { firstParam, type SearchParams } from "@/lib/pagination";
import { withTenant } from "@/server/session";
import {
  addNoteAction,
  completeTaskAction,
  createApprovalAction,
  createOpsCaseAction,
  createTaskAction,
  decideApprovalAction,
  decideBillableOpportunityAction,
  decideOpsCaseAction,
} from "../../actions/tenant";

export const dynamic = "force-dynamic";

const DENIAL_TEXT: Record<string, string> = {
  financial_requires_owner: "Financial approval — needs the owner (or a delegation rule).",
  red_requires_owner: "High-risk approval — owner only.",
  role_cannot_decide: "Your role can't decide approvals.",
};

export default async function InboxPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const approvalsCursor = firstParam(params, "approvalsCursor");
  const tasksCursor = firstParam(params, "tasksCursor");
  const clarificationsCursor = firstParam(params, "clarificationsCursor");
  const data = await withTenant(async (ctx, session) => {
    const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(session.role, p);
    const approvalsPage = can("approval.read")
      ? await listPendingApprovals(ctx, { cursor: approvalsCursor })
      : { items: [], nextCursor: null };
    const approvals = approvalsPage.items;
    const rules =
      can("approval.decide") || can("billable.decide")
        ? await loadApprovalDelegationRules(ctx)
        : [];
    const notes = can("note.read")
      ? await listNotes(
          ctx,
          "approval",
          approvals.map((a) => a.id),
        )
      : [];
    const tasksPage = can("task.read")
      ? await listOpenTasks(ctx, ["high", "urgent"], { cursor: tasksCursor })
      : { items: [], nextCursor: null };
    const tasks = tasksPage.items;
    const authority = new Map<string, DecisionAuthority>(
      approvals.map((a) => [a.id, evaluateApprovalDecision(ctx.actor, session.role, a, rules)]),
    );
    const billables = can("billable.decide") ? await listOpenBillableOpportunities(ctx) : [];
    const billableAuthority = can("billable.decide")
      ? evaluateApprovalDecision(
          ctx.actor,
          session.role,
          BILLABLE_OPPORTUNITY_POLICY_SUBJECT,
          rules,
        )
      : undefined;
    const clarificationsPage = can("ops_case.read")
      ? await listOrgOpsCases(ctx, { cursor: clarificationsCursor })
      : { items: [], nextCursor: null };
    const clarifications = clarificationsPage.items.filter(
      (c) => c.status !== "resolved" && c.status !== "closed",
    );
    return {
      session,
      approvals,
      approvalsNextCursor: approvalsPage.nextCursor,
      notes,
      tasks,
      tasksNextCursor: tasksPage.nextCursor,
      authority,
      billables,
      billableAuthority,
      clarifications,
      clarificationsNextCursor: clarificationsPage.nextCursor,
      can,
    };
  });
  const {
    session,
    approvals,
    approvalsNextCursor,
    notes,
    tasks,
    tasksNextCursor,
    authority,
    billables,
    billableAuthority,
    clarifications,
    clarificationsNextCursor,
    can,
  } = data;
  const tz = session.organization.timezone;

  return (
    <>
      <div className="page-head">
        <h1>Inbox</h1>
        <p>Only the decisions and exceptions that need you.</p>
      </div>

      <section className="section">
        <h2>Needs your decision ({approvals.length})</h2>
        {!can("approval.read") ? (
          <p className="empty">Approvals are handled by the office.</p>
        ) : approvals.length === 0 ? (
          <p className="empty">Nothing waiting on you.</p>
        ) : (
          approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              authority={authority.get(approval.id)}
              notes={notes.filter((n) => n.entityId === approval.id)}
              canNote={can("note.add")}
              timeZone={tz}
            />
          ))
        )}
        <PageNav
          basePath="/inbox"
          cursor={approvalsCursor}
          nextCursor={approvalsNextCursor}
          cursorParam="approvalsCursor"
        />
      </section>

      <section className="section">
        <h2>Billable opportunities ({billables.length})</h2>
        {!can("billable.decide") ? (
          <p className="empty">Billable opportunities are handled by the office.</p>
        ) : billables.length === 0 ? (
          <p className="empty">Nothing waiting on you.</p>
        ) : (
          billables.map((billable) => (
            <BillableOpportunityCard
              key={billable.id}
              billable={billable}
              authority={billableAuthority}
              timeZone={tz}
            />
          ))
        )}
      </section>

      <section className="section">
        <h2>Clarifications ({clarifications.length})</h2>
        {!can("ops_case.read") ? (
          <p className="empty">Clarifications are handled by the office.</p>
        ) : clarifications.length === 0 ? (
          <p className="empty">Nothing waiting on you.</p>
        ) : (
          clarifications.map((opsCase) => (
            <OpsCaseCard
              key={opsCase.id}
              opsCase={opsCase}
              canDecide={can("ops_case.resolve")}
              timeZone={tz}
            />
          ))
        )}
        <PageNav
          basePath="/inbox"
          cursor={clarificationsCursor}
          nextCursor={clarificationsNextCursor}
          cursorParam="clarificationsCursor"
        />
      </section>

      <section className="section">
        <h2>High-priority tasks ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p className="empty">No open high-priority tasks.</p>
        ) : (
          tasks.map((task) => (
            <div className="card" key={task.id}>
              <div className="card-head">
                <div>
                  <h3>{task.title}</h3>
                  <div className="meta">
                    <span className={`badge ${task.priority === "urgent" ? "red" : "yellow"}`}>
                      {task.priority}
                    </span>
                    Due {formatDateTime(task.dueAt, tz)}
                  </div>
                  {task.description ? <p>{task.description}</p> : null}
                </div>
                {can("task.update") ? (
                  <ActionForm action={completeTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <SubmitButton variant="secondary">Mark done</SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            </div>
          ))
        )}
        <PageNav
          basePath="/inbox"
          cursor={tasksCursor}
          nextCursor={tasksNextCursor}
          cursorParam="tasksCursor"
        />
      </section>

      {can("task.create") ? (
        <section className="section card">
          <h2>New task</h2>
          <ActionForm action={createTaskAction} className="grid-form">
            <label>
              Title
              <input name="title" required maxLength={200} />
            </label>
            <label>
              Priority
              <select name="priority" defaultValue="high">
                {PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              Due
              <input name="dueAt" type="datetime-local" />
            </label>
            <label>
              Details
              <input name="description" maxLength={4000} />
            </label>
            <SubmitButton>Create task</SubmitButton>
          </ActionForm>
        </section>
      ) : null}

      {can("approval.request") ? (
        <section className="section card">
          <h2>Request an approval</h2>
          <ActionForm action={createApprovalAction} className="grid-form">
            <input type="hidden" name="idempotencyKey" value={`web-${randomUUID()}`} />
            <label>
              Type
              <select name="type" defaultValue="purchase">
                <option value="purchase">Purchase</option>
                <option value="overtime">Overtime</option>
                <option value="change_order">Change order</option>
                <option value="schedule.change">Schedule change</option>
              </select>
            </label>
            <label>
              What
              <input name="title" required maxLength={200} />
            </label>
            <label>
              Amount ($, optional)
              <input name="amount" inputMode="decimal" pattern="[$]?[0-9,]+(\.[0-9]{1,2})?" />
            </label>
            <label>
              Why
              <input name="description" maxLength={4000} />
            </label>
            <SubmitButton>Request</SubmitButton>
          </ActionForm>
        </section>
      ) : null}

      {can("ops_case.create") ? (
        <section className="section card">
          <h2>Hand something to the Back Office team</h2>
          <ActionForm action={createOpsCaseAction} className="grid-form">
            <label>
              What do you need?
              <input name="title" required maxLength={200} />
            </label>
            <label>
              Reason
              <select name="reasonCode" defaultValue="other">
                {OPS_CASE_REASON_CODES.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <select name="priority" defaultValue="normal">
                {PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              Details
              <input name="details" maxLength={2000} />
            </label>
            <SubmitButton>Send</SubmitButton>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}

function ApprovalCard({
  approval,
  authority,
  notes,
  canNote,
  timeZone,
}: {
  approval: Approval;
  authority: DecisionAuthority | undefined;
  notes: Note[];
  canNote: boolean;
  timeZone: string;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{approval.title}</h3>
          <div className="meta">
            <span className={`badge ${approval.riskClass}`}>{approval.riskClass} risk</span>
            <span className="badge">{humanize(approval.type)}</span>
            Requested by {humanize(approval.requestedByActorType)} ·{" "}
            {formatDateTime(approval.createdAt, timeZone)}
            {approval.expiresAt ? ` · expires ${formatDateTime(approval.expiresAt, timeZone)}` : ""}
          </div>
        </div>
        <div className="amount">{formatMoney(approval.amountCents, approval.currency)}</div>
      </div>
      {approval.description ? <p>{approval.description}</p> : null}
      {notes.length > 0 ? (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n.id}>
              {n.body} <span className="meta">— {formatDateTime(n.createdAt, timeZone)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {authority?.allowed ? (
        <ActionForm action={decideApprovalAction} className="stack">
          <input type="hidden" name="approvalId" value={approval.id} />
          <label>
            Note (optional)
            <input name="note" maxLength={2000} />
          </label>
          <div className="row">
            <SubmitButton name="decision" value="approved">
              Approve
            </SubmitButton>
            <SubmitButton name="decision" value="rejected" variant="danger">
              Reject
            </SubmitButton>
          </div>
        </ActionForm>
      ) : (
        <p className="meta">
          {authority && !authority.allowed
            ? (DENIAL_TEXT[authority.reason] ?? "Awaiting decision.")
            : ""}
        </p>
      )}

      {canNote ? (
        <details>
          <summary>Add note</summary>
          <ActionForm action={addNoteAction} className="row">
            <input type="hidden" name="entityType" value="approval" />
            <input type="hidden" name="entityId" value={approval.id} />
            <input name="body" required maxLength={4000} aria-label="Note" />
            <SubmitButton variant="secondary">Add note</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </div>
  );
}

function BillableOpportunityCard({
  billable,
  authority,
  timeZone,
}: {
  billable: BillableOpportunity;
  authority: DecisionAuthority | undefined;
  timeZone: string;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{billable.description}</h3>
          <div className="meta">
            {billable.quantity !== null ? `${billable.quantity} ${billable.unit ?? ""}`.trim() : ""}
            {" · Reported "}
            {formatDateTime(billable.createdAt, timeZone)}
          </div>
        </div>
      </div>

      {authority?.allowed ? (
        <ActionForm action={decideBillableOpportunityAction} className="stack">
          <input type="hidden" name="billableOpportunityId" value={billable.id} />
          <label>
            Note (optional)
            <input name="note" maxLength={2000} />
          </label>
          <div className="row">
            <SubmitButton name="decision" value="approved">
              Approve
            </SubmitButton>
            <SubmitButton name="decision" value="dismissed" variant="secondary">
              Dismiss
            </SubmitButton>
          </div>
        </ActionForm>
      ) : (
        <p className="meta">
          {authority && !authority.allowed
            ? (DENIAL_TEXT[authority.reason] ?? "Awaiting decision.")
            : ""}
        </p>
      )}
    </div>
  );
}

function OpsCaseCard({
  opsCase,
  canDecide,
  timeZone,
}: {
  opsCase: OpsCase;
  canDecide: boolean;
  timeZone: string;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{opsCase.title}</h3>
          <div className="meta">
            <span className={`badge ${opsCase.priority === "urgent" ? "red" : "yellow"}`}>
              {humanize(opsCase.priority)}
            </span>
            <span className="badge">{humanize(opsCase.reasonCode)}</span>
            Opened {formatDateTime(opsCase.createdAt, timeZone)}
          </div>
        </div>
      </div>

      {canDecide ? (
        <ActionForm action={decideOpsCaseAction} className="stack">
          <input type="hidden" name="opsCaseId" value={opsCase.id} />
          <label>
            Note (required to resolve)
            <input name="note" maxLength={2000} />
          </label>
          <div className="row">
            <SubmitButton name="decision" value="resolved">
              Mark resolved
            </SubmitButton>
            <SubmitButton name="decision" value="dismissed" variant="secondary">
              Dismiss
            </SubmitButton>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}
