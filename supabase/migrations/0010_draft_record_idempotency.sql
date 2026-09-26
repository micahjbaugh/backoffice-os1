-- Back Office OS — M3 draft record idempotency
-- Extends 0007_time_entries.sql, 0008_equipment_material_usage.sql and
-- 0009_job_notes_billable_opportunities.sql (treated as deployed; never edited). See
-- docs/MILESTONES.md M3-T06.
--
-- The Field Capture Agent drafts time entries, equipment/material usage and job notes from one
-- crew message (MASTER_SPEC §C); replaying that message (e.g. a retried SMS webhook) must not
-- create duplicates. Each draft carries a caller-supplied fact_key identifying the extracted fact
-- within its source_communication_id (e.g. "time:0" for the first time entry extracted), and a
-- nullable + partial unique index mirrors leads.idempotency_key (0005_lead_idempotency.sql):
-- existing rows without a fact_key are unaffected.

alter table public.time_entries add column fact_key text;
create unique index time_entries_fact_key_unique
  on public.time_entries(organization_id, source_communication_id, fact_key)
  where source_communication_id is not null and fact_key is not null;

alter table public.equipment_usages add column fact_key text;
create unique index equipment_usages_fact_key_unique
  on public.equipment_usages(organization_id, source_communication_id, fact_key)
  where source_communication_id is not null and fact_key is not null;

alter table public.material_usages add column fact_key text;
create unique index material_usages_fact_key_unique
  on public.material_usages(organization_id, source_communication_id, fact_key)
  where source_communication_id is not null and fact_key is not null;

alter table public.job_notes add column fact_key text;
create unique index job_notes_fact_key_unique
  on public.job_notes(organization_id, source_communication_id, fact_key)
  where source_communication_id is not null and fact_key is not null;
