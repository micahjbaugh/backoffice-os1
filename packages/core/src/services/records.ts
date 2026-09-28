// Customers, employees, vendors and documents. These tables are client-writable under RLS, so
// row-level audit records are written by database trigger (0002) on every path; services add the
// business event.

import {
  createCustomerInput,
  createEmployeeInput,
  createVendorInput,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  registerDocumentInput,
  type CreateCustomerInput,
  type CreateEmployeeInput,
  type CreateVendorInput,
  type Customer,
  type DocumentMetadata,
  type Employee,
  type RegisterDocumentInput,
  type UUID,
  type Vendor,
} from "@backoffice/domain";
import { buildPage, decodeCursor, MAX_UNPAGINATED_ROWS, resolvePageSize } from "../pagination";
import type { CursorPage, PageParams } from "../pagination";
import { toCustomer, toDocument, toEmployee, toVendor, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

/**
 * Default signed-URL lifetime for document downloads (PH-T03): short enough to limit exposure if a
 * link leaks (e.g. via referrer, logs, or a forwarded message), long enough for one in-app click.
 */
export const DOCUMENT_DOWNLOAD_URL_TTL_SECONDS = 300;

interface NameCursor {
  displayName: string;
  id: string;
}

export function listCustomers(ctx: ServiceContext): Promise<Customer[]>;
export function listCustomers(ctx: ServiceContext, page: PageParams): Promise<CursorPage<Customer>>;
export async function listCustomers(
  ctx: ServiceContext,
  page?: PageParams,
): Promise<Customer[] | CursorPage<Customer>> {
  await ctx.authorize("customer.read");
  if (page === undefined) {
    const { rows } = await ctx.scoped<Row>(
      `select * from public.customers where organization_id = $1 order by display_name, id limit $2`,
      [ctx.organizationId, MAX_UNPAGINATED_ROWS],
    );
    return rows.map(toCustomer);
  }
  const limit = resolvePageSize(page.limit);
  const cursor = decodeCursor<NameCursor>(page.cursor);
  const { rows } = await ctx.scoped<Row>(
    `select * from public.customers
      where organization_id = $1
        and ($2::text is null or (display_name, id) > ($2, $3::uuid))
      order by display_name, id
      limit $4`,
    [ctx.organizationId, cursor?.displayName ?? null, cursor?.id ?? null, limit + 1],
  );
  const customers = rows.map(toCustomer);
  return buildPage(customers, limit, (c) => ({ displayName: c.displayName, id: c.id }));
}

export async function getCustomer(ctx: ServiceContext, customerId: UUID): Promise<Customer> {
  await ctx.authorize("customer.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.customers where id = $1 and organization_id = $2`,
    [customerId, ctx.organizationId],
  );
  if (!rows[0]) throw new NotFoundError("customer", customerId);
  return toCustomer(rows[0]);
}

export async function createCustomer(
  ctx: ServiceContext,
  input: CreateCustomerInput,
): Promise<Customer> {
  await ctx.authorize("customer.write");
  const data = parseInput(createCustomerInput, input);
  const { rows } = await ctx.scoped<Row>(
    `insert into public.customers (organization_id, display_name, phone, email, notes)
     values ($1, $2, $3, $4, $5) returning *`,
    [
      ctx.organizationId,
      data.displayName,
      data.phone ?? null,
      data.email ?? null,
      data.notes ?? null,
    ],
  );
  const customer = toCustomer(rows[0] as Row);
  await recordEvent(ctx, {
    type: EVENT_TYPES.customerCreated,
    entityType: "customer",
    entityId: customer.id,
    payload: { display_name: customer.displayName },
  });
  return customer;
}

export async function listEmployees(ctx: ServiceContext): Promise<Employee[]> {
  await ctx.authorize("employee.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.employees where organization_id = $1 order by display_name`,
    [ctx.organizationId],
  );
  return rows.map(toEmployee);
}

export async function createEmployee(
  ctx: ServiceContext,
  input: CreateEmployeeInput,
): Promise<Employee> {
  await ctx.authorize("employee.write");
  const data = parseInput(createEmployeeInput, input);
  const { rows } = await ctx.scoped<Row>(
    `insert into public.employees (organization_id, display_name, phone, email)
     values ($1, $2, $3, $4) returning *`,
    [ctx.organizationId, data.displayName, data.phone ?? null, data.email ?? null],
  );
  const employee = toEmployee(rows[0] as Row);
  await recordEvent(ctx, {
    type: EVENT_TYPES.employeeCreated,
    entityType: "employee",
    entityId: employee.id,
    payload: { display_name: employee.displayName },
  });
  return employee;
}

interface VendorCursor {
  notPreferred: boolean;
  displayName: string;
  id: string;
}

export function listVendors(ctx: ServiceContext): Promise<Vendor[]>;
export function listVendors(ctx: ServiceContext, page: PageParams): Promise<CursorPage<Vendor>>;
export async function listVendors(
  ctx: ServiceContext,
  page?: PageParams,
): Promise<Vendor[] | CursorPage<Vendor>> {
  await ctx.authorize("vendor.read");
  if (page === undefined) {
    const { rows } = await ctx.scoped<Row>(
      `select * from public.vendors
        where organization_id = $1
        order by preferred desc, display_name, id
        limit $2`,
      [ctx.organizationId, MAX_UNPAGINATED_ROWS],
    );
    return rows.map(toVendor);
  }
  const limit = resolvePageSize(page.limit);
  // "preferred desc" plus ascending tie-breakers can't be a single ROW `<`/`>` comparison, so sort
  // and page on `not preferred` (ascending) instead: identical order, one consistent direction.
  const cursor = decodeCursor<VendorCursor>(page.cursor);
  const { rows } = await ctx.scoped<Row>(
    `select * from public.vendors
      where organization_id = $1
        and ($2::boolean is null or (not preferred, display_name, id) > ($2, $3, $4::uuid))
      order by not preferred, display_name, id
      limit $5`,
    [
      ctx.organizationId,
      cursor?.notPreferred ?? null,
      cursor?.displayName ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const vendors = rows.map(toVendor);
  return buildPage(vendors, limit, (v) => ({
    notPreferred: !v.preferred,
    displayName: v.displayName,
    id: v.id,
  }));
}

export async function createVendor(ctx: ServiceContext, input: CreateVendorInput): Promise<Vendor> {
  await ctx.authorize("vendor.write");
  const data = parseInput(createVendorInput, input);
  const { rows } = await ctx.scoped<Row>(
    `insert into public.vendors (organization_id, display_name, phone, email, preferred)
     values ($1, $2, $3, $4, $5) returning *`,
    [ctx.organizationId, data.displayName, data.phone ?? null, data.email ?? null, data.preferred],
  );
  const vendor = toVendor(rows[0] as Row);
  await recordEvent(ctx, {
    type: EVENT_TYPES.vendorCreated,
    entityType: "vendor",
    entityId: vendor.id,
    payload: { display_name: vendor.displayName, preferred: vendor.preferred },
  });
  return vendor;
}

/** Register metadata for a file already placed in object storage (upload itself is out of M1). */
export async function registerDocument(
  ctx: ServiceContext,
  input: RegisterDocumentInput,
): Promise<DocumentMetadata> {
  await ctx.authorize("document.write");
  const data = parseInput(registerDocumentInput, input);
  await assertEntityInOrg(ctx, data.entityType, data.entityId);
  const { rows } = await ctx.scoped<Row>(
    `insert into public.documents
       (organization_id, storage_path, file_name, mime_type, classification, entity_type, entity_id, sha256)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      ctx.organizationId,
      data.storagePath,
      data.fileName,
      data.mimeType ?? null,
      data.classification,
      data.entityType ?? null,
      data.entityId ?? null,
      data.sha256 ?? null,
    ],
  );
  const doc = toDocument(rows[0] as Row);
  await recordEvent(ctx, {
    type: EVENT_TYPES.documentRegistered,
    entityType: "document",
    entityId: doc.id,
    payload: {
      classification: doc.classification,
      entity_type: doc.entityType,
      entity_id: doc.entityId,
    },
  });
  return doc;
}

export async function listDocuments(ctx: ServiceContext): Promise<DocumentMetadata[]> {
  await ctx.authorize("document.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.documents where organization_id = $1 order by created_at desc`,
    [ctx.organizationId],
  );
  return rows.map(toDocument);
}

/**
 * Authorize and audit a request to download a document's actual file content. Returns the metadata
 * needed to mint a signed URL; minting the URL itself is a storage-provider SDK call and stays out
 * of core (CLAUDE.md rules 9-10) — the caller does that with the returned `storagePath`.
 */
export async function requestDocumentDownload(
  ctx: ServiceContext,
  documentId: UUID,
): Promise<DocumentMetadata> {
  await ctx.authorize("document.download");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.documents where id = $1 and organization_id = $2`,
    [documentId, ctx.organizationId],
  );
  if (!rows[0]) throw new NotFoundError("document", documentId);
  const doc = toDocument(rows[0] as Row);
  await writeAudit(ctx, {
    action: "document.downloaded",
    entityType: "document",
    entityId: doc.id,
    details: { classification: doc.classification, file_name: doc.fileName },
  });
  return doc;
}
