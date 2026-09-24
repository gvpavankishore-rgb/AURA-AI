// Single source of truth for the frontend's own origin, used to build OAuth
// and email-confirmation redirect URLs that Supabase validates against its
// Auth -> URL Configuration allow-list.
//
// Resolution order:
//   1. VITE_SITE_URL - explicit canonical origin (set on Render). A value that
//      points at localhost is ignored in production builds so the deployed app
//      can never generate a localhost redirect.
//   2. window.location.origin - the origin the browser is actually on. This is
//      always the URL the user sees, so it is correct for local development,
//      the production Render static site, and preview deployments alike.
//   3. Development-only fallback 'http://localhost:5173' (dead-code eliminated
//      from production builds because it only exists in the import.meta.env.DEV
//      branch).
//
// No localhost string is ever produced for production builds (item 14).

const DEV_ORIGIN = 'http://localhost:5173';

const isLocalOrigin = (url) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(url || '').trim().replace(/\/+$/, ''));

const normalize = (url) => String(url || '').trim().replace(/\/+$/, '');

export const getFrontendOrigin = () => {
  const explicit = normalize(import.meta.env.VITE_SITE_URL);
  if (explicit && !(import.meta.env.PROD && isLocalOrigin(explicit))) return explicit;

  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return normalize(window.location.origin);
  }

  return import.meta.env.DEV ? DEV_ORIGIN : explicit;
};

export const getAuthCallbackUrl = () => `${getFrontendOrigin()}/auth/callback`;