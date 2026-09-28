-- PH-T01: storage for the fixed-window rate limiter (packages/core/src/services/rate-limit.ts).
-- One row per bucket key, e.g. "webhook:twilio:203.0.113.4", "signin:email:a@b.test",
-- "action:tenant:<org-id>". Never read or written from the browser and no tenant column applies
-- (a bucket key can span tenants, e.g. per-IP webhook keys), so there is no policy for
-- `authenticated`; RLS is still enabled for the same defense-in-depth reason every other
-- app_server-owned table has it (see migration 0017).
create table public.rate_limit_counters (
  bucket_key text primary key,
  window_start timestamptz not null,
  count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.rate_limit_counters enable row level security;
create policy rate_limit_counters_app_server_all on public.rate_limit_counters
  for all to app_server using (true) with check (true);
grant select, insert, update, delete on public.rate_limit_counters to app_server;
