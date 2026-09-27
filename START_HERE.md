# Start Here

## Where the project is

- **M1** (Business Brain + Owner Inbox) is accepted: automated tests plus a person's live verification
  (`docs/M1_LIVE_VERIFICATION.md`).
- **M2** (communications) has its foundations rebuilt by the 2026-09 repair (`docs/REPAIR_REPORT.md`):
  durable webhook ingestion, outbound queue, fail-closed provider configuration. The receptionist
  runtime, route management and the automated acceptance suite are explicit open tasks. The live
  phone check (M2-T17) needs a person and stays open until done.
- **M3** (field capture) is partly built and resumes after M2's automated acceptance passes.
- Live progress: `workflow/STATUS.md` on the `autopilot` branch. Do not use task counts as a readiness
  measure; see the milestone levels there and `docs/PRODUCTION_HARDENING.md`.

## Run it locally (reproducible)

Requirements: Node 22+ (24 tested), pnpm 10 (`npm i -g pnpm@10`), Git. For the local database: Docker
Desktop running (the Supabase CLI is a project dev dependency).

```bash
pnpm install --frozen-lockfile      # clean, exact install; re-run after every pull that adds packages
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test                           # all packages (PGlite, no Docker) + production build secret scan + referee tests
pnpm test:tz                        # date handling under UTC, America/Chicago, Asia/Tokyo

pnpm exec supabase start            # local Postgres/Auth/Studio with every migration + seed
cp apps/web/.env.example apps/web/.env.local   # fill from `pnpm exec supabase status`
pnpm dev                            # http://localhost:3000
```

On Windows, the repository's `.gitattributes` keeps files LF so formatting checks match CI. If an
old checkout shows formatting differences everywhere, re-checkout once (`git rm -r --cached . && git reset --hard`).

## The autopilot

Claude builds, an OpenAI model reviews, a deterministic referee decides, every 30 minutes in GitHub
Actions. How it works and how to control it: `workflow/README.md`. Rules every AI must follow:
`CLAUDE.md`.
