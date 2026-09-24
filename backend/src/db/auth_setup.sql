-- =====================================================================
-- AURA AI - Supabase Auth integration
-- Run this in the Supabase SQL editor AFTER schema.sql.
--
-- Links Supabase Auth (auth.users) to the app tables (public.users and
-- public.user_settings). A new user created via signUp / Google OAuth is
-- automatically given a public.users profile and default settings.
-- =====================================================================

-- App manages passwords via Supabase Auth, not this column. Allow ''.
alter table public.users
  alter column password_hash set default '';

-- ---------------------------------------------------------------------
-- Trigger: create profile + settings whenever auth.users gains a row
-- ---------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, name, email, avatar, memory_enabled)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(coalesce(new.email, 'user'), '@', 1),
      'User'
    ),
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', ''),
    true
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id, theme, language)
  values (new.id, 'dark', 'en')
  on conflict (user_id) do nothing;

  return new;
exception when unique_violation then
  -- The email is already owned by a LEGACY pre-Auth profile whose public.users
  -- id differs from new.id (classic "users_email_key" collision). Creating a
  -- second row here must never happen; instead leave profile creation to
  -- public.reconcile_user_profile(), which migrates the legacy profile and its
  -- data to new.id on the user's first authenticated request.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------
-- Backfill: for users who joined before this trigger existed (e.g. via
-- the old backend register endpoint), create their profiles/settings now.
-- ---------------------------------------------------------------------
insert into public.users (id, name, email, avatar, memory_enabled)
select
  u.id,
  coalesce(u.raw_user_meta_data->>'full_name', split_part(coalesce(u.email, 'user'), '@', 1), 'User'),
  coalesce(u.email, ''),
  coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture', ''),
  true
from auth.users u
left join public.users p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

insert into public.user_settings (user_id, theme, language)
select u.id, 'dark', 'en'
from auth.users u
left join public.user_settings s on s.user_id = u.id
where s.user_id is null
on conflict (user_id) do nothing;