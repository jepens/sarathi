-- Seed the existing single tenant (Sailendra) and make every current user its
-- owner. The fixed UUID is reused as the column DEFAULT in 0027, so existing
-- rows + ongoing service-role inserts land in this org until per-tenant routing
-- arrives (Fase 2).

insert into public.organizations (id, name, slug)
values ('5a11e024-0001-4000-8000-000000000001', 'Sailendra Organizer', 'sailendra')
on conflict (id) do nothing;

insert into public.organization_members (org_id, user_id, role)
select '5a11e024-0001-4000-8000-000000000001', u.id, 'owner'
from auth.users u
on conflict (org_id, user_id) do nothing;

-- Default org id for the service-role paths (webhook/queue) until Fase 2.
-- Insert-if-absent (no assumption about a UNIQUE constraint on app_settings.key).
insert into public.app_settings (key, value, description)
select
    'default_org_id',
    '5a11e024-0001-4000-8000-000000000001',
    'Fase 1 single-tenant default org for service-role writes'
where not exists (
    select 1 from public.app_settings where key = 'default_org_id'
);
