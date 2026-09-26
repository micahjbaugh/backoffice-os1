-- Back Office OS — decision authority for draft records (foundation repair, finding 7).
--
-- 0007–0009 gave owner/office_admin/manager `for all` access to time_entries, equipment_usages,
-- material_usages and billable_opportunities, so any of them could set `status` (approve time, bill
-- a customer) straight through PostgREST with no approval policy, event or decision record.
--
-- After this migration:
--   * clients (PostgREST and the app's user context) may create and edit DRAFT rows only;
--   * `status` and decision columns are not client-writable (column privileges);
--   * decisions happen in server services (packages/core/src/services/draft-decisions.ts) that apply
--     the domain policy and write an event + audit record;
--   * a decided row is immutable, even for privileged code, and every decision must record who
--     decided and when (guard trigger).

-- ---------------------------------------------------------------------------
-- 1. Decision columns.
-- ---------------------------------------------------------------------------
alter table public.time_entries
  add column decided_by_user_id uuid references auth.users(id) on delete set null,
  add column decided_at timestamptz,
  add column decision_note text;
alter table public.equipment_usages
  add column decided_by_user_id uuid references auth.users(id) on delete set null,
  add column decided_at timestamptz,
  add column decision_note text;
alter table public.material_usages
  add column decided_by_user_id uuid references auth.users(id) on delete set null,
  add column decided_at timestamptz,
  add column decision_note text;
alter table public.billable_opportunities
  add column decided_by_user_id uuid references auth.users(id) on delete set null,
  add column decided_at timestamptz,
  add column decision_note text,
  add column decision_policy_source text;

-- ---------------------------------------------------------------------------
-- 2. Guard: decided rows are immutable; decisions must name the decider.
-- ---------------------------------------------------------------------------
create or replace function public.guard_draft_decision()
returns trigger
language plpgsql
as $$
declare
  v_draft text := tg_argv[0];
  v_maintenance boolean := coalesce(current_setting('app.allow_append_only_maintenance', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.status::text <> v_draft and not v_maintenance then
      raise exception '% % is decided (%) and cannot be deleted', tg_table_name, old.id, old.status
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.status::text <> v_draft then
    -- Allow only the FK housekeeping of a deleted decider (on delete set null).
    if v_maintenance
       or (to_jsonb(new) - 'decided_by_user_id' - 'updated_at')
          = (to_jsonb(old) - 'decided_by_user_id' - 'updated_at') then
      return new;
    end if;
    raise exception '% % is already % and cannot change', tg_table_name, old.id, old.status
      using errcode = '42501';
  end if;

  if new.status::text <> v_draft and (new.decided_at is null or new.decided_by_user_id is null) then
    raise exception 'a decision on % must record decided_by_user_id and decided_at', tg_table_name
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger time_entries_decision_guard before update or delete on public.time_entries
  for each row execute function public.guard_draft_decision('draft');
create trigger equipment_usages_decision_guard before update or delete on public.equipment_usages
  for each row execute function public.guard_draft_decision('draft');
create trigger material_usages_decision_guard before update or delete on public.material_usages
  for each row execute function public.guard_draft_decision('draft');
create trigger billable_opportunities_decision_guard before update or delete on public.billable_opportunities
  for each row execute function public.guard_draft_decision('open');

-- ---------------------------------------------------------------------------
-- 3. Row policies: staff read everything, but only create/edit/delete drafts.
-- ---------------------------------------------------------------------------
drop policy time_entries_staff_all on public.time_entries;
drop policy equipment_usages_staff_all on public.equipment_usages;
drop policy material_usages_staff_all on public.material_usages;
drop policy billable_opportunities_staff_all on public.billable_opportunities;

create policy time_entries_staff_select on public.time_entries for select to authenticated
  using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy time_entries_staff_insert_draft on public.time_entries for insert to authenticated
  with check (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy time_entries_staff_update_draft on public.time_entries for update to authenticated
  using (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
  with check (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy time_entries_staff_delete_draft on public.time_entries for delete to authenticated
  using (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy equipment_usages_staff_select on public.equipment_usages for select to authenticated
  using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy equipment_usages_staff_insert_draft on public.equipment_usages for insert to authenticated
  with check (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy equipment_usages_staff_update_draft on public.equipment_usages for update to authenticated
  using (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
  with check (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy equipment_usages_staff_delete_draft on public.equipment_usages for delete to authenticated
  using (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy material_usages_staff_select on public.material_usages for select to authenticated
  using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy material_usages_staff_insert_draft on public.material_usages for insert to authenticated
  with check (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy material_usages_staff_update_draft on public.material_usages for update to authenticated
  using (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
  with check (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy material_usages_staff_delete_draft on public.material_usages for delete to authenticated
  using (status = 'draft' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

create policy billable_opportunities_staff_select on public.billable_opportunities for select to authenticated
  using (public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy billable_opportunities_staff_insert_open on public.billable_opportunities for insert to authenticated
  with check (status = 'open' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy billable_opportunities_staff_update_open on public.billable_opportunities for update to authenticated
  using (status = 'open' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]))
  with check (status = 'open' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));
create policy billable_opportunities_staff_delete_open on public.billable_opportunities for delete to authenticated
  using (status = 'open' and public.has_org_role(organization_id, array['owner','office_admin','manager']::public.membership_role[]));

-- ---------------------------------------------------------------------------
-- 4. Column privileges: decision and provenance columns are server-only.
-- ---------------------------------------------------------------------------
revoke insert, update on public.time_entries from authenticated;
grant insert (organization_id, employee_id, job_id, work_date, start_at, end_at, hours, confidence, evidence)
  on public.time_entries to authenticated;
grant update (employee_id, job_id, work_date, start_at, end_at, hours, confidence, evidence)
  on public.time_entries to authenticated;

revoke insert, update on public.equipment_usages from authenticated;
grant insert (organization_id, equipment_id, job_id, hours, confidence, evidence)
  on public.equipment_usages to authenticated;
grant update (equipment_id, job_id, hours, confidence, evidence)
  on public.equipment_usages to authenticated;

revoke insert, update on public.material_usages from authenticated;
grant insert (organization_id, job_id, description, quantity, unit, confidence, evidence)
  on public.material_usages to authenticated;
grant update (job_id, description, quantity, unit, confidence, evidence)
  on public.material_usages to authenticated;

revoke insert, update on public.billable_opportunities from authenticated;
grant insert (organization_id, job_id, description, quantity, unit, confidence, evidence)
  on public.billable_opportunities to authenticated;
grant update (job_id, description, quantity, unit, confidence, evidence)
  on public.billable_opportunities to authenticated;
