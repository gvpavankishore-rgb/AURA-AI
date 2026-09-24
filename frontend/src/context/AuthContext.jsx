import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { supabase } from '../lib/supabase';
import api from '../services/api';

const AuthContext = createContext(null);

const OLD_TOKEN_KEY = 'aura_token';
const OLD_REFRESH_KEY = 'aura_refresh';

const friendlyAuthError = (error) => {
  const message = error?.message || 'Something went wrong';
  const code = error?.code || error?.status || '';
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return 'Google sign-in is not enabled for this AURA AI account yet. Please contact your administrator, or sign in with email and password.';
  }
  if (/access_denied|consent denied|user cancelled/i.test(message)) {
    return 'Google sign-in was cancelled. No changes were made to your account.';
  }
  if (/invalid_grant|expired|invalid code|code exchange/i.test(message)) {
    return 'Your sign-in session has expired. Please try signing in with Google again.';
  }
  if (code === 'email_not_confirmed' || /not confirmed/i.test(message)) {
    return 'Please confirm your email address before signing in. Check your inbox for the confirmation link.';
  }
  if (/invalid login credentials/i.test(message)) {
    return 'Incorrect email or password.';
  }
  if (/already registered|already been registered/i.test(message)) {
    return 'This email is already registered. Please sign in instead.';
  }
  if (/rate limit/i.test(message)) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  return message;
};

const normEmail = (email) => {
  if (/^\S+@\S+\.\S+$/.test(email)) return email;
  return email.includes('@') && email.endsWith('.com') ? email : `${email}@gmail.com`;
};

const toAppUser = (authUser, profile) => {
  const meta = authUser?.user_metadata || {};
  return {
    id: authUser?.id,
    name: profile?.name || meta.full_name || meta.name || (authUser?.email || 'user').split('@')[0] || 'User',
    email: authUser?.email || '',
    avatar: profile?.avatar || meta.avatar_url || meta.picture || '',
    emailConfirmed: Boolean(authUser?.email_confirmed_at),
  };
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // In-flight guards: guarantee that one user action produces exactly ONE
  // Supabase Auth request, even under double-clicks, Enter-key spam, or
  // concurrent invocations. Duplicate calls are swallowed silently.
  const loginInFlight = useRef(false);
  const registerInFlight = useRef(false);
  const googleInFlight = useRef(false);

  const lastSyncedToken = useRef(null);

  const syncProfile = useCallback(async (session) => {
    const token = session?.access_token || null;
    console.log(`[AuthDebug] syncProfile - session exists: ${Boolean(session?.user)}, token length: ${token?.length || 0}`);
    if (lastSyncedToken.current === token) return;
    lastSyncedToken.current = token;

    if (!session?.user) {
      api.setAccessToken(null);
      setUser(null);
      return;
    }
    api.setAccessToken(session.access_token);
    const baseUser = toAppUser(session.user, null);
    setUser(baseUser);
    let profile = null;
    try {
      const res = await api.getProfile();
      if (res?.success) profile = res.data?.user || null;
    } catch {}
    setUser(toAppUser(session.user, profile));
  }, []);

  useEffect(() => {
    // remove stale tokens from the previous backend-JWT auth system
    localStorage.removeItem(OLD_TOKEN_KEY);
    localStorage.removeItem(OLD_REFRESH_KEY);

    let mounted = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setLoading(false);
        await syncProfile(data.session);
      } catch {
        if (!mounted) return;
        setLoading(false);
      }
    })();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) syncProfile(session);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [syncProfile]);

  const login = async (email, password) => {
    if (loginInFlight.current) return { success: false, silent: true };
    loginInFlight.current = true;
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: normEmail(email.trim()),
        password,
      });
      if (error) return { success: false, message: friendlyAuthError(error) };
      if (data.session) await syncProfile(data.session);
      return { success: true };
    } catch (err) {
      return { success: false, message: friendlyAuthError(err) };
    } finally {
      loginInFlight.current = false;
    }
  };

  const register = async (name, email, password) => {
    if (registerInFlight.current) return { success: false, silent: true };
    registerInFlight.current = true;
    try {
      const { data, error } = await supabase.auth.signUp({
        email: normEmail(email.trim()),
        password,
        options: {
          data: { full_name: name.trim() },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) return { success: false, message: friendlyAuthError(error) };
      if (data.user && data.user.identities && data.user.identities.length === 0) {
        return { success: false, message: 'This email is already registered. Please sign in instead.' };
      }
      if (data.session) await syncProfile(data.session);
      return { success: true, needsEmailConfirmation: !data.session };
    } catch (err) {
      return { success: false, message: friendlyAuthError(err) };
    } finally {
      registerInFlight.current = false;
    }
  };

  const continueWithGoogle = async () => {
    if (googleInFlight.current) return { success: false, silent: true };
    googleInFlight.current = true;
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) return { success: false, message: friendlyAuthError(error) };
      if (data?.url) {
        window.location.assign(data.url);
        return { success: true, redirecting: true };
      }
      return { success: true };
    } catch (err) {
      return { success: false, message: friendlyAuthError(err) };
    } finally {
      googleInFlight.current = false;
    }
  };

  const logout = async () => {
    try { await supabase.auth.signOut(); } catch {}
    api.setAccessToken(null);
    setUser(null);
  };

  const updateUser = (updates) => setUser(prev => (prev ? { ...prev, ...updates } : prev));

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, continueWithGoogle, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);