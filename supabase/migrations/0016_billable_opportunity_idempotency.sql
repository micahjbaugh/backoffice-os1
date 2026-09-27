-- Back Office OS — M3 scope-change detection idempotency (M3-T15)
-- Extends 0009_job_notes_billable_opportunities.sql (treated as deployed; never edited). See
-- docs/MILESTONES.md M3-T15.
--
-- The Field Capture Agent drafts a billable_opportunity from a "scope change" fact in the same
-- crew message it drafts time/equipment/material facts from; replaying that message must not
-- create a second opportunity. billable_opportunities predates fact_key (0010 added it to every
-- other draft table but not this one); this migration catches it up with the identical
-- caller-supplied fact_key + nullable partial unique index pattern.

alter table public.billable_opportunities add column fact_key text;
create unique index billable_opportunities_fact_key_unique
  on public.billable_opportunities(organization_id, source_communication_id, fact_key)
  where source_communication_id is not null and fact_key is not null;
