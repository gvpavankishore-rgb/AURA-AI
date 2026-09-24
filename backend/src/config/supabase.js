import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@supabase/supabase-js';
import env from './env.js';

// Request-scoped context. The authenticate / optionalAuth middleware wraps
// each request in `requestStore.run({ token })` so that every query issued by
// the model layer is executed as the authenticated (logged-in) Supabase user.
// This lets the Supabase RLS policies (`auth.uid() = user_id`) enforce row
// ownership instead of relying only on app-layer filters.
export const requestStore = new AsyncLocalStorage();

let anonClient = null;

const MAX_CACHED_CLIENTS = 200;

// Per-token clients. Caching is safe because each client is bound to a single
// user's access token (no shared mutable session), so concurrent requests from
// different users can never see each other's rows.
const cachedClients = new Map();

export const isSupabaseConfigured = () => Boolean(env.supabaseUrl && env.supabaseAnonKey);

const assertConfigured = () => {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env');
  }
  if (/(\/rest\/v1|\/auth\/v1|\/storage\/v1)\/?$/i.test(env.supabaseUrl)) {
    throw new Error(
      `Invalid SUPABASE_URL "${env.supabaseUrl}". Use the project base URL without an API path, e.g. https://your-ref.supabase.co`
    );
  }
};

// Build a supabase-js client whose REST calls carry the given JWT. This is
// required so that PostgREST resolves the role to `authenticated` and sets
// `auth.uid()` to the logged-in user, letting RLS policies apply. When no
// token is supplied (e.g. outside a request), the anon/publishable client is
// returned.
//
// IMPORTANT: the client is created with the REAL anon/publishable key as the
// API key, and the user's JWT is sent only via the `Authorization` header
// override. Passing the JWT itself as the API key (createClient(url, jwt))
// makes GoTrue reject auth calls with "Invalid API key" -> 401, because the
// `apikey` header must be a project API key, not a user access token.
const getClient = () => {
  assertConfigured();
  const token = requestStore.getStore()?.token;
  if (!token) {
    return getAnonClient();
  }

  const cached = cachedClients.get(token);
  if (cached) return cached;

  if (cachedClients.size >= MAX_CACHED_CLIENTS) {
    const oldestKey = cachedClients.keys().next().value;
    cachedClients.delete(oldestKey);
  }

  const scoped = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  cachedClients.set(token, scoped);
  return scoped;
};

// The plain anon/publishable client. Used for supabase.auth.getUser(token)
// verification: the `apikey` header must be the real project key for GoTrue
// to accept the request.
export const getAnonClient = () => {
  assertConfigured();
  if (!anonClient) {
    anonClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  return anonClient;
};

export const getSupabase = () => getClient();

export default getSupabase;