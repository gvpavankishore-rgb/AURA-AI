import { createClient } from '@supabase/supabase-js';
import env from './env.js';

let client = null;

export const isSupabaseConfigured = () => Boolean(env.supabaseUrl && env.supabaseAnonKey);

export const getSupabase = () => {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env');
  }
  if (/(\/rest\/v1|\/auth\/v1|\/storage\/v1)\/?$/i.test(env.supabaseUrl)) {
    throw new Error(
      `Invalid SUPABASE_URL "${env.supabaseUrl}". Use the project base URL without an API path, e.g. https://your-ref.supabase.co`
    );
  }
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
};

export default getSupabase;