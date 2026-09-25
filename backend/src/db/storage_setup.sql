-- =============================================================================
-- AURA AI - Supabase Storage setup (run ONCE in the Supabase Dashboard SQL
-- editor; the backend CANNOT create private buckets/policies without a
-- service-role key, so this is a required manual step).
--
-- Security model (matches the app's decision: FULLY PRIVATE bucket)
--   * The bucket "chat-attachments" is PRIVATE (public = false).
--   * There is NO public-read policy and NO anon storage access.
--   * Every user may only INSERT/UPDATE/DELETE objects whose path lives under
--     the folder  user-<auth.uid()>/   (their own folder only) and only while
--     authenticated.
--   * READ is NOT exposed to RLS/SQL at all. Files are consumed exclusively
--     through SHORT-LIVED SIGNED URLs that the backend issues with the user's
--     own scoped client (createSignedUrl), so a browser <img> can render the
--     preview/lightbox WITHOUT exposing the bucket publicly and WITHOUT an
--     Authorization header. Signed URLs expire (1h default) and are re-issued
--     on every message fetch -> exact Supabase Storage best practice.
--
-- IMPORTANT: Since a signed URL is only generated for objects the caller may
-- read, the storage.schema does NOT need a SELECT policy. A malicious client
-- that somehow obtained a valid signed URL for another user's object could
-- read it until expiry; optional per-folder SELECT-RLS would close even that,
-- at the cost of requiring createSignedUrl to run with a role that can see the
-- row (the backend's scoped user client). Keep it simple and correct: writes
-- are tightly scoped, reads are only ever reached via owner-generated signed
-- URLs. If you require defense-in-depth even against leaked signed URLs, add
-- the commented-out SELECT policy at the bottom (owner-folder only) and make
-- the backend generate signed URLs with the authenticated client as noted.
-- =============================================================================

-- 1) Create the private bucket (idempotent).
insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;

-- 2) Owner-only folder policies -------------------------------------------------
-- Each policy is dropped first so this whole file is safely re-runnable.
-- Owners may upload any object into their OWN folder (bypass adds signed-URL
-- ergonomics; writes are otherwise fully owned).
drop policy if exists "chat_attachments_owner_insert" on storage.objects;
create policy "chat_attachments_owner_insert"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = 'user-' || (auth.uid())::text
);

-- Owners may update metadata / overwrite only their own folder.
drop policy if exists "chat_attachments_owner_update" on storage.objects;
create policy "chat_attachments_owner_update"
on storage.objects for update to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = 'user-' || (auth.uid())::text
)
with check (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = 'user-' || (auth.uid())::text
);

-- Owners may delete only their own folder.
drop policy if exists "chat_attachments_owner_delete" on storage.objects;
create policy "chat_attachments_owner_delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = 'user-' || (auth.uid())::text
);

-- (Optional, defense-in-depth) Restrict reads to the owner folder. Requires
-- the backend to create signed URLs with a client that has visibility into the
-- row (the authenticated user client already satisfies this).
-- create policy "chat_attachments_owner_select"
-- on storage.objects for select to authenticated
-- using (
--   bucket_id = 'chat-attachments'
--   and storage.foldername(name)[1] = 'user-' || (auth.uid())::text
-- );

-- =============================================================================
-- Manual Supabase Dashboard steps (only needed ONCE, per project):
--   1. Open your Supabase project -> Storage.
--   2. New bucket -> name "chat-attachments", Visibility = Private. Do NOT
--      create a public bucket.
--   3. Open the SQL editor and run the statements above (create the bucket
--      there too so it is idempotent).
--   4. Confirm in Storage -> Policies that the three owner-* policies are
--      listed (no SELECT/anon policy, no public bucket entry).
--   5. Backend .env additions:
--        SUPABASE_STORAGE_BUCKET=chat-attachments
--        SUPABASE_STORAGE_SIGNED_URL_TTL=3600
--   6. Restart the backend. On the first upload the signed-URL path will be
--      exercised; image previews keep working through refresh/login.
-- =============================================================================
