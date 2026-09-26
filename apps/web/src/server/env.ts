import "server-only";

// Server-only secrets. `server-only` makes any client-component import of this module a build error.

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set (see apps/web/.env.example)");
  return url;
}
