-- Analytics minimo de retencion para StudiAI.
-- Aplicado a la instancia szysukwkumphvltaiwpn (schema studiai, aislado del
-- schema de agenda-giova que comparte la misma instancia).
-- Objetivo: medir si los usuarios de la beta vuelven (cohortes de retencion).

-- 1) Marca de usuario interno (Sebastian / testers) para excluir de metricas.
alter table studiai.users
  add column if not exists is_internal boolean not null default false;

-- 2) Tabla de eventos de uso (un "app_open" por arranque autenticado).
create table if not exists studiai.usage_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references studiai.users(id) on delete cascade,
  event       text not null default 'app_open',
  app_version text,
  platform    text,
  created_at  timestamptz not null default now()
);

create index if not exists usage_events_user_created_idx
  on studiai.usage_events (user_id, created_at);
create index if not exists usage_events_created_idx
  on studiai.usage_events (created_at);

-- 3) RLS: el usuario autenticado solo inserta SUS propios eventos.
--    Sin policy de SELECT -> nadie los lee salvo service_role (SQL editor),
--    que bypassa RLS. Las metricas se consultan solo desde el dashboard.
alter table studiai.usage_events enable row level security;

drop policy if exists usage_events_insert_own on studiai.usage_events;
create policy usage_events_insert_own
  on studiai.usage_events
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- 4) Grants para insertar via PostgREST como rol authenticated.
grant usage on schema studiai to authenticated;
grant insert on table studiai.usage_events to authenticated;

-- 5) Recargar el schema cache de PostgREST para exponer la tabla nueva.
notify pgrst, 'reload schema';

-- Nota: el marcado de usuarios internos es un cambio de DATOS (no DDL) y se
-- corre aparte, p. ej.:
--   update studiai.users set is_internal = true where email = 'tu@correo.com';
