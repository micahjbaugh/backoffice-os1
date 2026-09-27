-- Back Office OS — M2 task idempotency
-- Extends 0002_m1_foundation.sql (treated as deployed; never edited). See docs/MILESTONES.md M2-T20.
--
-- The receptionist's create_callback_task tool is agent-callable and Vapi may redeliver the same
-- tool-calls webhook; replaying it must not create a second task. Nullable + partial unique index
-- mirrors leads.idempotency_key (0005_lead_idempotency.sql): existing rows without a key are
-- unaffected.

alter table public.tasks add column idempotency_key text;

create unique index tasks_idempotency_unique
  on public.tasks(organization_id, idempotency_key)
  where idempotency_key is not null;
