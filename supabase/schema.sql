-- PrepaTrack — schéma de synchronisation
--
-- À coller tel quel dans Supabase : menu « SQL Editor » → « New query » → Run.
-- Peut être relancé sans risque (tout est en "if not exists" / "drop policy if exists").
--
-- Choix de conception : AUCUNE clé étrangère entre les tables métier.
-- Le téléphone est la source de vérité, ce schéma n'est qu'un miroir de
-- transport. Sans contraintes croisées, l'envoi d'un lot partiel (réseau coupé
-- au milieu) ne peut jamais échouer en boucle sur un ordre d'insertion.
-- L'intégrité est garantie côté client, où tout est écrit dans une transaction.
--
-- Les horodatages sont des bigint (millisecondes epoch), pas des timestamptz :
-- c'est exactement ce que manipule JavaScript, donc zéro conversion et zéro
-- ambiguïté de fuseau horaire entre l'iPhone et le PC.

-- ---------------------------------------------------------------- workdays --
create table if not exists public.workdays (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  date text not null,
  status text not null,
  started_at bigint not null,
  ended_at bigint,
  overtime_started_at bigint,
  notes text,
  updated_at bigint not null,
  deleted_at bigint
);

-- ------------------------------------------------------------------ orders --
create table if not exists public.orders (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  workday_id text not null,
  status text not null,
  order_type text not null,
  colis_planned integer not null default 0,
  lines_count integer not null default 0,
  colis_actual integer,
  supports jsonb not null default '{}'::jsonb,
  started_at bigint not null,
  ended_at bigint,
  updated_at bigint not null,
  deleted_at bigint
);

-- ---------------------------------------------------------------- segments --
create table if not exists public.segments (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  workday_id text not null,
  order_id text,
  type text not null,
  started_at bigint not null,
  ended_at bigint,
  stack jsonb,
  edited_at bigint,
  note text,
  updated_at bigint not null,
  deleted_at bigint
);

-- ------------------------------------------------------------ colis_events --
create table if not exists public.colis_events (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  workday_id text not null,
  order_id text not null,
  at bigint not null,
  delta integer not null,
  updated_at bigint not null,
  deleted_at bigint
);

-- Index sur updated_at : la synchro ne redemande que ce qui a changé depuis le
-- dernier passage, jamais l'historique complet.
create index if not exists workdays_sync_idx on public.workdays (user_id, updated_at);
create index if not exists orders_sync_idx on public.orders (user_id, updated_at);
create index if not exists segments_sync_idx on public.segments (user_id, updated_at);
create index if not exists colis_events_sync_idx on public.colis_events (user_id, updated_at);

-- ------------------------------------------------------ sécurité des lignes --
-- Chaque ligne n'est lisible et modifiable que par son propriétaire. Même si la
-- clé publique de l'application fuitait, personne ne pourrait voir ces données.
alter table public.workdays enable row level security;
alter table public.orders enable row level security;
alter table public.segments enable row level security;
alter table public.colis_events enable row level security;

drop policy if exists "workdays owner" on public.workdays;
create policy "workdays owner" on public.workdays
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "orders owner" on public.orders;
create policy "orders owner" on public.orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "segments owner" on public.segments;
create policy "segments owner" on public.segments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "colis_events owner" on public.colis_events;
create policy "colis_events owner" on public.colis_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
