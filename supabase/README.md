# Database (Supabase / Postgres)

## Migrations

| File | Purpose |
|---|---|
| `migrations/0001_core.sql` | Original core schema. Treated as deployed — never edit it. |
| `migrations/0002_m1_foundation.sql` | M1: internal staff, grant expiry/revocation, notes, RLS fixes and policies, client privilege revokes, append-only audit/events, approval immutability, row-mutation audit triggers. |

Add new changes as new numbered files (`0003_...sql`). Never edit an applied migration.

## Applying migrations

### Local (Supabase CLI + Docker)

```bash
# once
pnpm install                # Supabase CLI is a project dev dependency
# from the repository root
pnpm exec supabase start     # boots Postgres, Auth, Studio; applies migrations + seed.sql
pnpm exec supabase status    # prints API URL, anon key and DB URL for apps/web/.env.local
pnpm exec supabase db reset  # re-create the local DB from migrations + seed.sql
```

### Hosted Supabase project

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push             # applies pending migrations; does NOT run seed.sql
```

Never run `seed.sql` against a hosted project: it creates users with a known password.

## Access model (summary)

- Every tenant table has RLS. Browser/PostgREST requests and the app server's user-scoped queries
  both run as role `authenticated` with the user's JWT claims.
- Approvals, events, audit log, ops cases, operator grants, rules, notes, organizations and
  memberships are **read-only** for clients; the app server writes them after code-level authorization.
- Customers, employees, vendors, jobs, tasks and documents are writable by staff under RLS and are
  audited by trigger on every write path.
- `audit_log` and `business_events` are append-only; decided approvals are immutable.

## Tests

The RLS/authorization tests do not need Docker: `packages/core` runs them against PGlite (Postgres
compiled to WASM) with `packages/core/test/helpers/supabase-shim.sql` standing in for Supabase's
roles and `auth` schema, then applies these same migration files.
