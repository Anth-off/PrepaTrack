-- PrepaTrack — passage en multi-utilisateurs (préparateurs + gestionnaires)
--
-- À appliquer APRÈS schema.sql. Rejouable sans risque.
-- Le script `npm run db:setup` l'applique automatiquement.
--
-- Principe : Supabase authentifie par e-mail, or un préparateur s'identifie par
-- son numéro de badge. On fabrique donc une adresse technique à partir du badge
-- (1234567 -> 1234567@prepatrack.local). Ce domaine n'existe pas et ne reçoit
-- jamais rien : aucun message n'est envoyé, le code personnel tient lieu de mot
-- de passe.

-- ------------------------------------------------------------- préparateurs --
create table if not exists public.preparers (
  id uuid primary key default gen_random_uuid(),
  badge text unique not null,
  name text not null,
  role text not null default 'preparer' check (role in ('preparer', 'manager')),
  -- Renseigné à la première connexion, quand le compte est réellement créé.
  user_id uuid unique references auth.users on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists preparers_user_idx on public.preparers (user_id);

-- ------------------------------------------------------------------ rôles ----
-- `security definer` : la fonction doit lire `preparers` sans être elle-même
-- soumise aux règles de sécurité, sinon la vérification du rôle dépendrait du
-- rôle — et ne renverrait jamais vrai.
-- `search_path` figé : sans cela, un schéma temporaire malveillant pourrait
-- détourner la résolution des noms de tables.
create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.preparers
    where user_id = auth.uid()
      and role = 'manager'
      and active
  );
$$;

-- Rattache le compte fraîchement créé au préparateur portant ce badge.
-- C'est ce qui empêche l'inscription libre : sans badge déclaré au préalable
-- par un gestionnaire, la création de compte échoue.
create or replace function public.link_preparer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_badge text;
  v_id uuid;
  v_user uuid;
begin
  v_badge := split_part(new.email, '@', 1);

  select id, user_id into v_id, v_user
    from public.preparers
   where badge = v_badge and active;

  if v_id is null then
    raise exception 'Badge inconnu ou désactivé';
  end if;

  if v_user is not null then
    raise exception 'Ce badge a déjà un compte';
  end if;

  update public.preparers set user_id = new.id where id = v_id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.link_preparer();

-- ------------------------------------------------------ sécurité des lignes --
alter table public.preparers enable row level security;

-- Chacun lit sa propre fiche ; un gestionnaire lit toute l'équipe.
drop policy if exists "preparers read" on public.preparers;
create policy "preparers read" on public.preparers
  for select using (user_id = auth.uid() or public.is_manager());

-- Seul un gestionnaire ajoute, modifie ou désactive un préparateur. Un
-- préparateur ne peut donc pas se promouvoir lui-même.
drop policy if exists "preparers write" on public.preparers;
create policy "preparers write" on public.preparers
  for all using (public.is_manager()) with check (public.is_manager());

-- Les tables de production : chacun les siennes, le gestionnaire toutes.
do $$
declare t text;
begin
  foreach t in array array['workdays', 'orders', 'order_pallets', 'segments', 'colis_events', 'stock_shortages', 'coaching_alerts'] loop
    execute format('drop policy if exists %I on public.%I', t || ' owner', t);
    execute format('drop policy if exists %I on public.%I', t || ' access', t);
    execute format(
      'create policy %I on public.%I for all
         using (user_id = auth.uid() or public.is_manager())
         with check (user_id = auth.uid() or public.is_manager())',
      t || ' access', t
    );
  end loop;
end $$;

-- ------------------------------------------- protection contre la cascade ----
-- Les tables de production pointaient vers auth.users en « on delete cascade » :
-- supprimer un compte depuis le tableau de bord Supabase aurait effacé d'un
-- coup toute la production du préparateur. On bascule en « restrict » : la
-- suppression est refusée tant qu'il reste des données.
do $$
declare
  r record;
begin
  for r in
    select tc.table_name, tc.constraint_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY'
       and tc.table_schema = 'public'
       and tc.table_name in ('workdays', 'orders', 'order_pallets', 'segments', 'colis_events', 'stock_shortages', 'coaching_alerts')
       and kcu.column_name = 'user_id'
  loop
    execute format('alter table public.%I drop constraint %I', r.table_name, r.constraint_name);
    execute format(
      'alter table public.%I add constraint %I foreign key (user_id)
         references auth.users (id) on delete restrict',
      r.table_name, r.constraint_name
    );
  end loop;
end $$;

-- ----------------------------------------------- réinitialisation d'un code --
-- Un code oublié doit pouvoir être redéfini sans passer par le tableau de bord.
-- Modifier le mot de passe d'un autre compte exige normalement la clé de
-- service, qui n'a rien à faire dans une application web : cette fonction fait
-- le travail côté base, réservée aux gestionnaires.
create extension if not exists pgcrypto;

create or replace function public.reset_preparer_pin(p_preparer_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user uuid;
begin
  if not public.is_manager() then
    raise exception 'Réservé aux gestionnaires';
  end if;

  if p_new_pin !~ '^\d{6}$' then
    raise exception 'Le code doit comporter 6 chiffres';
  end if;

  select user_id into v_user from public.preparers where id = p_preparer_id;
  if v_user is null then
    raise exception 'Ce préparateur n''a pas encore de compte';
  end if;

  update auth.users
     set encrypted_password = crypt(p_new_pin, gen_salt('bf')),
         updated_at = now()
   where id = v_user;
end;
$$;

revoke all on function public.reset_preparer_pin(uuid, text) from public, anon;
grant execute on function public.reset_preparer_pin(uuid, text) to authenticated;

-- --------------------------------------------------------------- amorçage ----
-- Crée le premier gestionnaire. Sans lui, personne ne pourrait déclarer les
-- badges de l'équipe. Le compte lui-même naîtra à la première connexion.
create or replace function public.seed_manager(p_badge text, p_name text)
returns void
language sql
as $$
  insert into public.preparers (badge, name, role)
  values (p_badge, p_name, 'manager')
  on conflict (badge) do update set role = 'manager', active = true;
$$;
