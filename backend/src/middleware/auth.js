import { getAnonClient, getSupabase, requestStore } from '../config/supabase.js';
import { AppError } from './errorHandler.js';
import User from '../models/User.js';
import UserSettings from '../models/UserSettings.js';

const isDuplicateError = (err) =>
  err?.statusCode === 409 || /duplicate/i.test(err?.message || '');

// Logs a REDACTED summary of a reconciled profile. Never tokens/keys.
const logReconcile = (authUserId, result) => {
  if (!result || typeof result !== 'object') return;
  console.log(
    `[AuthDebug][reconcile] authUserId=${authUserId} action=${result.action} profileId=${result.profile_id || 'n/a'} ${result.legacy_matched ? `legacyId=${result.legacy_id} moved=${JSON.stringify(result.moved)}` : ''}`
  );
};

// Calls the security-definer reconcile RPC (backend/src/db/migration_reconcile_user_profiles.sql).
// Runs as the authenticated user but is executed with definer privileges, so it
// may see/handle the invisible legacy row. It only ever reconciles the caller's
// own identity (the SQL re-checks auth.uid()). Idempotent: existing profile ->
// returns it; same-email legacy row -> migrates its data to the auth id; none ->
// creates the canonical row.
const reconcileProfile = async (authUser) => {
  const sb = getSupabase();
  const { data, error } = await sb.rpc('reconcile_user_profile', {
    p_auth_user_id: authUser.id,
    p_email: authUser.email || '',
    p_name:
      authUser.user_metadata?.full_name ||
      authUser.user_metadata?.name ||
      (authUser.email || '').split('@')[0] ||
      '',
    p_avatar: authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || '',
  });
  if (error) {
    console.error(`[AuthDebug][reconcile] RPC failed for ${authUser.id}:`, error?.message || error);
    console.error('[AuthDebug][reconcile] If reconcile_user_profile is missing, run backend/src/db/migration_reconcile_user_profiles.sql against the Supabase database (SQL editor).');
    throw new AppError('Could not reconcile your profile', 500);
  }
  logReconcile(authUser.id, data);
  return data;
};

const ensureSettings = async (userId) => {
  let settings;
  try {
    // Note: SupabaseModel.findOne() returns a thenable query chain, not a
    // Promise — await it, never call .catch() on it.
    settings = await UserSettings.findOne({ user: userId });
  } catch (err) {
    console.error(`[Auth][settings] Failed to read settings for ${userId}:`, err?.message || err);
    throw new AppError('Could not read user settings', 500);
  }
  if (settings) return settings;

  try {
    settings = await UserSettings.create({ user: userId });
    return settings;
  } catch (err) {
    if (isDuplicateError(err)) {
      // A concurrent request created them first — reuse that row.
      try {
        settings = await UserSettings.findOne({ user: userId });
      } catch (readErr) {
        console.error(`[Auth][settings] Failed to re-read settings for ${userId}:`, readErr?.message || readErr);
        throw new AppError('Could not read user settings', 500);
      }
      if (settings) return settings;
    }
    console.error(`[Auth][settings] Failed to create settings for ${userId}:`, err?.message || err);
    throw new AppError('Could not prepare user settings', 500);
  }
};

/**
 * Resolves (and, if necessary, provisions) the application profile for a
 * verified Supabase auth user.
 *
 * INVARIANT: profile._id === authUser.id. Email is never used as the identity
 * key, and no synthetic/fake profile is ever returned. If a legacy public.users
 * row holds the same email under a different id, it is reconciled server-side
 * via the security-definer RPC and its real data is preserved under the auth id.
 *
 * Idempotent sync sequence:
 *   1. lookup by authenticated user id
 *   2. if missing, safely check email (RLS-scoped)
 *   3. reconcile (create the canonical row, or migrate the same-email legacy
 *      row) exactly once via the RPC = declarative create, no blind insert
 *   4. re-fetch and verify the final row's id equals authUser.id
 *   5. only then continue (returns the real profile; never a fallback id)
 */
const ensureProfile = async (authUser) => {
  const authId = authUser?.id;
  if (!authId) throw new AppError('Verification failed', 401);

  const name =
    authUser.user_metadata?.full_name ||
    authUser.user_metadata?.name ||
    (authUser.email || '').split('@')[0] ||
    'User';
  const avatar = authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || '';

  // 1) Canonical lookup: the authenticated Supabase Auth user id.
  let profile = await User.findOne({ _id: authId });
  if (profile) {
    if (profile._id !== authId) throw new AppError('Profile identity mismatch', 500);
    // Refresh harmless identity fields (name/avatar) only. Email is never
    // touched here: ownership of the email belongs to the reconcile RPC, so a
    // same-email legacy row can never collide.
    if (profile.name !== name || profile.avatar !== avatar) {
      await User.findOneAndUpdate({ _id: authId }, { name, avatar });
    }
    await ensureSettings(authId);
    console.log(`[AuthDebug][profile] found id=${profile._id} for authUser ${authId}`);
    return profile;
  }
  console.log(`[AuthDebug][profile] id=${authId} -> not found`);

  // 2) Safe email check. RLS (id = auth.uid()) means this can only see the
  //    caller's own rows, so it is a hint that a profile exists under a
  //    different public.users.id. It can never leak another user's profile.
  let byEmail = null;
  if (authUser.email) {
    byEmail = await User.findOne({ email: authUser.email });
    console.log(`[AuthDebug][profile] lookup by email (${authUser.email || ''}) -> ${byEmail ? 'found' : 'not found'}`);
  }

  // 3) Same-email profile under a different id: migrate it to the canonical
  //    auth id (data-preserving), never shadow it and never duplicate it.
  if (byEmail && byEmail._id !== authId) {
    console.log(`[AuthDebug][profile] email maps to profile ${byEmail._id} != authUserId ${authId} - reconciling`);
    await reconcileProfile(authUser);
    profile = await User.findOne({ _id: authId });
  } else {
    // No profile by id and none visible by email: create exactly once. If the
    // create fails with a duplicate, an INVISIBLE legacy row (hidden by RLS)
    // owns this email -> the privileged RPC migrates that row's data to the
    // auth id and claims the email back. A non-duplicate failure propagates.
    try {
      profile = await User.create({ id: authId, name, email: authUser.email || '', avatar });
      profile = (await User.findOne({ _id: authId })) || profile;
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
      console.log(`[AuthDebug][profile] create failed for ${authId}: ${err.message} - reconciling`);
      await reconcileProfile(authUser);
      profile = await User.findOne({ _id: authId });
    }
  }

  // 4) Re-fetch already happened above; verify the final row. We only ever
  //    continue when the profile's id equals authUser.id - there is no
  //    fallback to a fake/other-id profile.
  if (!profile || profile._id !== authId) {
    console.error(`[AuthDebug][profile] no valid profile after sync for authUser ${authId} (read=${profile ? profile._id : 'null'})`);
    throw new AppError('Profile reconciliation did not produce a matching profile', 500);
  }

  // 5) user_settings must reference the same canonical users.id (authUser.id).
  await ensureSettings(authId);
  console.log(`[AuthDebug][profile] final profile id=${profile._id} for authUser ${authId}`);
  return profile;
};

const resolveUser = async (token) => {
  if (!token) return null;
  // Token verification runs on the plain anon/publishable client: GoTrue
  // requires the `apikey` header to be a real project key (a user JWT in that
  // position causes "Invalid API key" -> 401).
  const { data, error } = await getAnonClient().auth.getUser(token);
  if (error || !data?.user) {
    console.log(`[AuthDebug][verify] token present (len ${token.length}) -> ${error ? `FAILED: ${error.message}` : 'no user'}`);
    return null;
  }
  console.log(`[AuthDebug][verify] token present (len ${token.length}) -> OK (${data.user.id})`);
  const profile = await ensureProfile(data.user);
  return { authUserId: data.user.id, profile };
};

const extractToken = (req) => {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7) : null;
};

const describeToken = (token) => (token ? `present (${token.length} chars)` : 'MISSING');

const authErrorResponse = (res, token, verifyError) => {
  const message = String(verifyError?.message || '');
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication token is missing. Please sign in.' });
  }
  if (/expired|expiration/i.test(message)) {
    return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
  }
  return res.status(401).json({ success: false, message: 'Invalid authentication token. Please sign in again.' });
};

export const authenticate = (req, res, next) => {
  const rawToken = extractToken(req);
  void requestStore.run({ token: rawToken }, async () => {
    try {
      const token = requestStore.getStore()?.token;
      console.log(`[AuthDebug][authenticate] ${req.method} ${req.originalUrl} - authorization: Bearer ${describeToken(token)}`);
      if (!token) {
        return authErrorResponse(res, null);
      }
      const user = await resolveUser(token);
      if (!user) {
        return authErrorResponse(res, token, null);
      }
      req.authUserId = user.authUserId;
      req.user = user.profile;
      console.log(`[AuthDebug][authenticate] req.user=${req.user._id} -> ${req.method} ${req.originalUrl} (authenticated)`);
      next();
    } catch (err) {
      // Profile provisioning/reconciliation failures must surface loudly, not
      // be hidden behind a misleading 401.
      console.error('[AuthDebug][authenticate] profile resolution failed:', err?.message || err);
      res.status(err?.statusCode || 500).json({ success: false, message: err?.message || 'Authentication failed' });
    }
  });
};

export const optionalAuth = (req, res, next) => {
  const rawToken = extractToken(req);
  void requestStore.run({ token: rawToken }, async () => {
    try {
      const token = requestStore.getStore()?.token;
      if (token) {
        const user = await resolveUser(token);
        if (user) {
          req.authUserId = user.authUserId;
          req.user = user.profile;
        }
      }
      next();
    } catch (err) {
      console.error('[AuthDebug][optionalAuth] profile resolution failed:', err?.message || err);
      next(err);
    }
  });
};