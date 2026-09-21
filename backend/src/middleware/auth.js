import { getSupabase } from '../config/supabase.js';
import User from '../models/User.js';
import UserSettings from '../models/UserSettings.js';

const ensureProfile = async (authUser) => {
  let profile = await User.findOne({ _id: authUser.id });
  if (!profile) {
    const meta = authUser.user_metadata || {};
    const name = meta.full_name || meta.name || (authUser.email || 'user').split('@')[0] || 'User';
    profile = await User.create({
      id: authUser.id,
      name,
      email: authUser.email || '',
      avatar: meta.avatar_url || meta.picture || '',
    }).catch(async () => {
      return User.findOne({ _id: authUser.id });
    });
    if (profile) {
      try { await UserSettings.create({ user: profile._id }); } catch {}
    }
  }
  return profile;
};

const resolveUser = async (token) => {
  if (!token) return null;
  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data?.user) return null;
  return ensureProfile(data.user);
};

const extractToken = (req) => {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7) : null;
};

export const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const user = await resolveUser(token);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Authentication failed' });
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (token) {
      const user = await resolveUser(token);
      if (user) req.user = user;
    }
  } catch {}
  next();
};