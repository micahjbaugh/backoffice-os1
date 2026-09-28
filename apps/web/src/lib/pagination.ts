export type SearchParams = Record<string, string | string[] | undefined>;

/** Next.js repeats a query param as an array; list pages only ever read the first cursor given. */
export function firstParam(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}
