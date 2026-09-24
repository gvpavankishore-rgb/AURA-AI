-- =====================================================================
-- AURA AI - Reconcile legacy public.users profiles with Supabase Auth
-- =====================================================================
-- PROBLEM
--   Older AURA accounts created before Supabase Auth had public.users rows
--   whose id was a random UUID UNLIKE the Supabase auth.users.id, but with the
--   SAME email. After the migration, such rows are invisible to the current
--   user (RLS policy: id = auth.uid()), so the backend could not see them;
--   Profile.create then hit the "users_email_key" unique constraint and fell
--   back to a synthetic profile -> user_settings / conversations FK failures
--   ("users_email_key", "user_settings_user_id_fkey", "conversations_user_id_fkey").
--
-- FIX
--   A SECURITY DEFINER function the backend calls through PostgREST RPC after
--   JWT verification. It runs with the privileges of the function owner
--   (bypassing RLS) but ONLY for the caller's OWN identity
--   (auth.uid() = p_auth_user_id). It:
--     1. returns the profile when public.users.id == auth.users.id, or creates it
--     2. on an invisible legacy row with the same email but a different id,
--        migrates the legacy row's real child rows to the auth id
--        (user_settings, conversations [-> messages], documents, memories),
--        deletes dead legacy refresh_token sessions, deletes the obsolete
--        legacy users row, and claims back the canonical email for the auth id
--     3. always ensures a user_settings row exists for the auth id
--   Normal application queries remain fully RLS-scoped: only this one
--   reconciliation call may bypass RLS, and only for the caller's own id.
--
-- HOW TO APPLY
--   Open the Supabase dashboard -> SQL Editor -> New query -> paste this file
--   -> Run. It is idempotent (CREATE OR REPLACE + grant), so running it twice
--   is safe.
-- =====================================================================

create or replace function public.reconcile_user_profile(
  p_auth_user_id uuid,
  p_email text default '',
  p_name text default '',
  p_avatar text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target  public.users%rowtype;
  v_legacy  public.users%rowtype;
  v_name    text;
  v_avatar  text;
  v_moved_settings         int := 0;
  v_moved_conversations    int := 0;
  v_moved_documents        int := 0;
  v_moved_memories         int := 0;
  v_legacy_refresh_tokens  int := 0;
begin
  if p_auth_user_id is null then
    raise exception 'reconcile_user_profile: p_auth_user_id is required';
  end if;

  -- SAFETY: a user may only reconcile their OWN identity. auth.uid() is null
  -- for anonymous calls, so anon/guests can never reconcile anyone.
  if auth.uid() is distinct from p_auth_user_id then
    raise exception 'reconcile_user_profile: permission denied (may only reconcile your own profile)';
  end if;

  v_name   := coalesce(nullif(p_name, ''), split_part(coalesce(nullif(p_email, ''), 'user'), '@', 1), 'User');
  v_avatar := coalesce(nullif(p_avatar, ''), '');

  select * into v_target from public.users where id = p_auth_user_id;

  -- 1) Profile already exists for the auth id: sync identity fields, ensure
  --    settings, done. (Email is only updated if it does not collide with a
  --    different row.)
  if v_target.id is not null then
    if p_email is not null and p_email <> ''
       and v_target.email is distinct from p_email
       and not exists (select 1 from public.users where id <> p_auth_user_id and email = p_email) then
      update public.users set email = p_email where id = p_auth_user_id;
    end if;
    update public.users
       set name       = coalesce(nullif(p_name, ''), name),
           avatar     = coalesce(nullif(p_avatar, ''), avatar),
           updated_at = now()
     where id = p_auth_user_id;
    insert into public.user_settings (user_id) values (p_auth_user_id)
      on conflict (user_id) do nothing;
    return jsonb_build_object(
      'matched', true,
      'action', 'existing',
      'profile_id', p_auth_user_id::text
    );
  end if;

  -- 2) Look for an invisible legacy profile with the same email but a
  --    different id (the classic pre-Auth row).
  if p_email is not null and p_email <> '' then
    select * into v_legacy
      from public.users
     where email = p_email
       and id <> p_auth_user_id
     order by created_at asc
     limit 1;
  end if;

  if v_legacy.id is not null then
    -- 2a) Create the canonical users row FIRST (it is the FK parent the child
    --     updates below need to reference). Its email is a unique, obviously
    --     temporary value: the legacy row still holds the real email until the
    --     children have been moved.
    insert into public.users (id, name, email, avatar)
    values (
      p_auth_user_id,
      coalesce(v_legacy.name, v_name),
      'migrating-' || replace(p_auth_user_id::text, '-', '') || '-' || p_email,
      coalesce(v_legacy.avatar, v_avatar)
    )
    on conflict (id) do update
      set name = excluded.name, avatar = excluded.avatar;

    -- 2b) Move every legitimate child row from the legacy id to the auth id.
    --     messages ride along with conversations (messages.conversation_id
    --     references conversations.id; there is no users FK on messages).
    update public.user_settings set user_id = p_auth_user_id, updated_at = now()
      where user_id = v_legacy.id;
    get diagnostics v_moved_settings = row_count;

    update public.conversations set user_id = p_auth_user_id, updated_at = now()
      where user_id = v_legacy.id;
    get diagnostics v_moved_conversations = row_count;

    update public.documents set user_id = p_auth_user_id, updated_at = now()
      where user_id = v_legacy.id;
    get diagnostics v_moved_documents = row_count;

    update public.memories set user_id = p_auth_user_id
      where user_id = v_legacy.id;
    get diagnostics v_moved_memories = row_count;

    -- Legacy public.refresh_tokens are DEAD SESSIONS for the old identity.
    -- Never re-issue them under the new id; drop them instead.
    delete from public.refresh_tokens where user_id = v_legacy.id;
    get diagnostics v_legacy_refresh_tokens = row_count;

    -- 2c) The legacy row now has no children it owns; drop it. All child rows
    --     were explicitly migrated first, so the ON DELETE CASCADE removes
    --     nothing of the user's. This also frees the email for step 2d.
    delete from public.users where id = v_legacy.id;

    -- 2d) Claim the canonical email back onto the auth-id profile.
    if p_email is not null and p_email <> '' then
      update public.users
         set email = p_email,
             name  = coalesce(nullif(v_name, ''), name),
             avatar = coalesce(nullif(v_avatar, ''), avatar)
       where id = p_auth_user_id;
    end if;

    insert into public.user_settings (user_id) values (p_auth_user_id)
      on conflict (user_id) do nothing;

    return jsonb_build_object(
      'matched', true,
      'legacy_matched', true,
      'action', 'reconciled',
      'legacy_id', v_legacy.id::text,
      'profile_id', p_auth_user_id::text,
      'moved', jsonb_build_object(
        'settings', v_moved_settings,
        'conversations', v_moved_conversations,
        'documents', v_moved_documents,
        'memories', v_moved_memories,
        'refresh_tokens_removed', v_legacy_refresh_tokens
      )
    );
  end if;

  -- 3) No legacy conflict (or legacy email empty): create the canonical
  --    profile directly.
  insert into public.users (id, name, email, avatar)
  values (p_auth_user_id, v_name, coalesce(p_email, ''), v_avatar)
  on conflict (id) do update
    set name = excluded.name, email = excluded.email, avatar = excluded.avatar;

  insert into public.user_settings (user_id) values (p_auth_user_id)
    on conflict (user_id) do nothing;

  return jsonb_build_object(
    'matched', true,
    'action', 'created',
    'profile_id', p_auth_user_id::text
  );
end;
$$;

-- Only authenticated Supabase users may invoke it (and the function itself
-- re-checks that they may only reconcile their own id).
grant execute on function public.reconcile_user_profile(uuid, text, text, text)
  to authenticated;

revoke execute on function public.reconcile_user_profile(uuid, text, text, text)
  from public;