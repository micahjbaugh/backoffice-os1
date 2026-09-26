export function formatMoney(cents: number | null, currency: string | null = "USD"): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(
    cents / 100,
  );
}

export function formatDateTime(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function humanize(value: string): string {
  return value.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
