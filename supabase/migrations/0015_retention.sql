-- Back Office OS — retention of webhook payloads and communication transcripts (M2-T25).
--
-- Two independent, per-organization windows:
--   * webhook_payload_retention_days: once a webhook event reaches a terminal *successful* state
--     (processed/ignored) and that long has passed since it was processed, its payload body is
--     cleared. Identity (provider, event key, resource id, status, timestamps) stays, so the event
--     store keeps its dedupe/audit trail forever. Events still needing work (received, processing,
--     failed, dead, unroutable) are never touched — only a successfully handled event's body goes.
--   * communication_retention_days: once a call/message has ended and that long has passed since it
--     ended, its transcript/summary/structured extraction are cleared and retention_status moves to
--     'deleted'. Calls/messages/participants/disposition (identities) and every event/audit record
--     are untouched. A communication still `in_progress` is never touched.
-- Defaults are conservative starting points; a future settings surface can let an org tune them.

alter table public.organizations
  add column webhook_payload_retention_days integer not null default 30,
  add column communication_retention_days integer not null default 365,
  add constraint organizations_webhook_payload_retention_positive
    check (webhook_payload_retention_days > 0),
  add constraint organizations_communication_retention_positive
    check (communication_retention_days > 0);

-- Marks a webhook event's payload as already cleared, so the purge is idempotent without needing
-- to distinguish "never had a payload" from "payload was purged".
alter table public.webhook_receipts add column payload_purged_at timestamptz;
