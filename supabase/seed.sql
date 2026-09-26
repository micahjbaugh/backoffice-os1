-- LOCAL DEVELOPMENT DATA ONLY. Applied by `supabase db reset` / `supabase start`.
-- Never run against a hosted project: it creates users with a known password.
--
-- Sign in at http://localhost:3000 with any of these (password: backoffice-dev-1):
--   owner@acme.test     Owner of Acme Excavation
--   admin@acme.test     Office admin at Acme
--   crew@acme.test      Field employee at Acme
--   owner@bravo.test    Owner of Bravo Concrete (second tenant, for isolation checks)
--   ops@backoffice.test Internal operator (no tenant access until an owner grants it)
--
-- Seed rows are inserted directly (not through the app services), so they carry audit entries
-- only where database triggers create them.

do $$
declare
  v_users jsonb := '[
    {"id": "11111111-1111-4111-8111-111111111111", "email": "owner@acme.test"},
    {"id": "11111111-1111-4111-8111-111111111112", "email": "admin@acme.test"},
    {"id": "11111111-1111-4111-8111-111111111113", "email": "crew@acme.test"},
    {"id": "22222222-2222-4222-8222-222222222221", "email": "owner@bravo.test"},
    {"id": "99999999-9999-4999-8999-999999999999", "email": "ops@backoffice.test"}
  ]';
  v_user jsonb;
begin
  for v_user in select * from jsonb_array_elements(v_users) loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      (v_user ->> 'id')::uuid,
      'authenticated',
      'authenticated',
      v_user ->> 'email',
      extensions.crypt('backoffice-dev-1', extensions.gen_salt('bf')),
      now(),
      '{"provider": "email", "providers": ["email"]}',
      '{}',
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(),
      (v_user ->> 'id')::uuid,
      v_user ->> 'id',
      jsonb_build_object('sub', v_user ->> 'id', 'email', v_user ->> 'email', 'email_verified', true),
      'email',
      now(), now(), now()
    );
  end loop;
end $$;

insert into public.organizations (id, name, slug, timezone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Acme Excavation', 'acme-excavation', 'America/Chicago'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Bravo Concrete', 'bravo-concrete', 'America/Denver');

insert into public.memberships (organization_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111112', 'office_admin'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111113', 'field_employee'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222221', 'owner');

insert into public.internal_staff (user_id, role) values
  ('99999999-9999-4999-8999-999999999999', 'ops_agent');

insert into public.customers (id, organization_id, display_name, phone, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'Wilson Farms', '555-0101', 'office@wilsonfarms.test'),
  ('aaaaaaaa-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001', 'County Road Dept', '555-0102', null),
  ('bbbbbbbb-0000-4000-8000-0000000000c1', 'bbbbbbbb-0000-4000-8000-000000000001', 'Bravo-only Customer', '555-0201', null);

insert into public.jobs (organization_id, customer_id, name, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'Wilson pond dig', 'active'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c2', 'CR 12 culvert', 'scheduled'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000c1', 'Bravo driveway pour', 'draft');

insert into public.vendors (organization_id, display_name, phone, preferred) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Hill Country Rock & Gravel', '555-0301', true),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Tri-County Pipe Supply', '555-0302', false);

insert into public.employees (organization_id, display_name, phone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Jake Tyler', '555-0401'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Maria Lopez', '555-0402');

insert into public.approvals
  (organization_id, type, title, description, risk_class, amount_cents, requested_by_actor_type, idempotency_key)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'purchase', '21 ton crushed rock for Wilson pond',
   'Hill Country quoted $450 delivered tomorrow AM.', 'yellow', 45000, 'agent', 'seed-purchase-rock'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'overtime', 'Saturday overtime for culvert crew',
   '2 operators x 6 hrs to beat the rain.', 'yellow', null, 'user', 'seed-overtime-sat'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'schedule.change', 'Move CR 12 culvert start to Thursday',
   'County asked to push one day.', 'green', null, 'agent', 'seed-schedule-cr12'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'purchase', 'Used mini-excavator (capital purchase)',
   'Owner-only: large capital purchase.', 'red', 3850000, 'user', 'seed-capital-mini-ex');

insert into public.tasks (organization_id, title, description, priority) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Call Wilson back about extra 200 ft of grading', 'Possible change order.', 'high'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Renew CDL medical card for Jake', null, 'urgent');

insert into public.ops_cases (organization_id, title, reason_code, priority, evidence, created_by_actor_type) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Crew text could not be matched to a job', 'low_confidence', 'high',
   '{"message": "Me Jake Tyler 7-5:30 Wilson. Hoe 8 hrs"}', 'system');
