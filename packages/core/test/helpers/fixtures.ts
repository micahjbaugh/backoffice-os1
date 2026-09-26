import type { Customer, Job, MembershipRole, UUID } from "@backoffice/domain";
import { addMember, createCustomer, createJob, createOrganizationWithOwner } from "../../src";
import { asTx, createTestDatabase, createUser, inOrg, userActor, type TestDatabase } from "./db";

export interface OrgFixture {
  id: UUID;
  owner: UUID;
  officeAdmin: UUID;
  manager: UUID;
  fieldEmployee: UUID;
  accountant: UUID;
  customer: Customer;
  job: Job;
}

export interface World extends TestDatabase {
  orgA: OrgFixture;
  orgB: OrgFixture;
  /** Active internal staff member with no grants yet. */
  operator: UUID;
  /** Authenticated user who is neither a member of anything nor internal staff. */
  outsider: UUID;
}

async function createOrg(t: TestDatabase, label: string): Promise<OrgFixture> {
  const owner = await createUser(t.pg, `owner@${label}.test`);
  const org = await asTx(t.db, userActor(owner), (tx) =>
    createOrganizationWithOwner(tx, { name: `Org ${label.toUpperCase()}`, slug: `org-${label}` }),
  );

  const members = {} as Record<Exclude<MembershipRole, "owner">, UUID>;
  for (const role of [
    "office_admin",
    "manager",
    "field_employee",
    "accountant_readonly",
  ] as const) {
    const email = `${role}@${label}.test`;
    members[role] = await createUser(t.pg, email);
    await inOrg(t.db, userActor(owner), org.id, (ctx) => addMember(ctx, { email, role }));
  }

  const customer = await inOrg(t.db, userActor(owner), org.id, (ctx) =>
    createCustomer(ctx, { displayName: `${label} Customer`, phone: "555-0100" }),
  );
  const job = await inOrg(t.db, userActor(owner), org.id, (ctx) =>
    createJob(ctx, { name: `${label} Job`, customerId: customer.id }),
  );

  return {
    id: org.id,
    owner,
    officeAdmin: members.office_admin,
    manager: members.manager,
    fieldEmployee: members.field_employee,
    accountant: members.accountant_readonly,
    customer,
    job,
  };
}

export async function createWorld(): Promise<World> {
  const t = await createTestDatabase();
  const orgA = await createOrg(t, "a");
  const orgB = await createOrg(t, "b");
  const operator = await createUser(t.pg, "operator@backoffice.test");
  await t.pg.query(`insert into public.internal_staff (user_id, role) values ($1, 'ops_agent')`, [
    operator,
  ]);
  const outsider = await createUser(t.pg, "outsider@elsewhere.test");
  return { ...t, orgA, orgB, operator, outsider };
}
