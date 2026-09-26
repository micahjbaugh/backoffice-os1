-- Back Office OS — M2 lead idempotency
-- Extends 0004_leads.sql (treated as deployed; never edited). See docs/MASTER_SPEC.md §7-8.
--
-- The createLead domain tool (M2-T10) is agent-callable and must be idempotent: a duplicate call
-- with the same key creates exactly one lead. Nullable + partial unique index mirrors
-- business_events (0001_core.sql §business_events_idempotency_unique) so existing manual/raw lead
-- inserts without a key are unaffected.

alter table public.leads add column idempotency_key text;

create unique index leads_idempotency_unique
  on public.leads(organization_id, idempotency_key)
  where idempotency_key is not null;
