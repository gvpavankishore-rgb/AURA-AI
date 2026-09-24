import { getAnonClient, requestStore } from '../config/supabase.js';
import User from '../models/User.js';
import UserSettings from '../models/UserSettings.js';

const findExistingProfile = async (authUser) => {
  let profile = null;
  if (authUser.id) {
    profile = await User.findOne({ _id: authUser.id });
    console.log(`[AuthDebug][profile] lookup by id (${authUser.id}) -> ${profile ? 'FOUND' : 'not found'}`);
  }
  if (!profile && authUser.email) {
    profile = await User.findOne({ email: authUser.email });
    console.log(`[AuthDebug][profile] lookup by email (${authUser.email}) -> ${profile ? 'FOUND' : 'not found'}`);
  }
  return profile;
};

const ensureProfile = async (authUser) => {
  console.log(`[AuthDebug][profile] authUser.id=${authUser.id} authUser.email=${authUser.email || '(none)'}`);
  let profile = await findExistingProfile(authUser);
  if (!profile) {
    const meta = authUser.user_metadata || {};
    const name = meta.full_name || meta.name || (authUser.email || 'user').split('@')[0] || 'User';
    try {
      profile = await User.create({
        id: authUser.id,
        name,
        email: authUser.email || '',
        avatar: meta.avatar_url || meta.picture || '',
      });
      console.log(`[AuthDebug][profile] created profile (${authUser.id})`);
    } catch (err) {
      const isDuplicate = err?.statusCode === 409 || /duplicate/i.test(err?.message || '');
      console.log(`[AuthDebug][profile] create failed: ${err?.message || err} (duplicate=${isDuplicate})`);
      if (isDuplicate) {
        profile = await findExistingProfile(authUser);
      }
      if (!profile) {
        // The JWT is verified, but the conflicting/stale row is not visible
        // to this user's role (RLS ownership policy: id = auth.uid()), so no
        // readable profile exists. Keep auth flowing with a profile derived
        // from the verified token instead of failing with a 401.
        console.warn(`[AuthDebug][profile] no readable profile after conflict; falling back to verified token user (${authUser.id})`);
        profile = {
          _id: authUser.id,
          id: authUser.id,
          name,
          email: authUser.email || '',
          avatar: meta.avatar_url || meta.picture || '',
          memoryEnabled: true,
        };
      }
    }
    if (profile) {
      try { await UserSettings.create({ user: profile._id }); } catch (e) {
        console.log(`[AuthDebug][profile] UserSettings create skipped: ${e?.message || e}`);
      }
    }
  }
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
  return ensureProfile(data.user);
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
      let user = null;
      let verifyError = null;
      try {
        user = await resolveUser(token);
      } catch (err) {
        verifyError = err;
        console.error('[AuthDebug][authenticate] verification threw:', err?.message || err);
      }
      if (!user) {
        return authErrorResponse(res, token, verifyError);
      }
      req.user = user;
      console.log(`[AuthDebug][authenticate] req.user=${req.user._id} -> ${req.method} ${req.originalUrl} (authenticated)`);
      next();
    } catch (err) {
      console.error('[AuthDebug][authenticate] unexpected error:', err?.message || err);
      return res.status(401).json({ success: false, message: 'Authentication failed' });
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
        if (user) req.user = user;
      }
    } catch {}
    next();
  });
};