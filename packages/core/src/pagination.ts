// Shared cursor pagination for list services. Callers that omit `page` keep getting a plain
// array (capped, never unbounded); callers that pass `page` opt into keyset pagination and get a
// `CursorPage` back. Cursors are opaque base64url-encoded JSON of the row's own sort key plus id,
// so a page never depends on OFFSET (stable under concurrent inserts/deletes, unlike offset paging).

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Cap for the legacy non-paginated callers: keeps every list query bounded, even unpaginated ones. */
export const MAX_UNPAGINATED_ROWS = 1000;

export interface PageParams {
  cursor?: string | null;
  limit?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function resolvePageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

export function encodeCursor(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
}

/** Returns null for a missing, malformed or tampered cursor: callers must treat that as "first page". */
export function decodeCursor<T>(cursor: string | null | undefined): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Split rows fetched with `limit + 1` into a page of `limit` and the cursor for the next one.
 * `cursorOf` extracts the fields the query's own keyset condition needs from the last kept row.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => Record<string, unknown>,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows.slice();
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}
