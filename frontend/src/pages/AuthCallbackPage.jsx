import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Sparkles } from 'lucide-react';

const oauthFriendly = (description) => {
  const desc = String(description || '');
  if (/redirect_uri_mismatch|redirect uri mismatch/i.test(desc)) {
    return 'Sign-in is not configured correctly yet. The Google OAuth redirect URL is mismatched — please tell the administrator (expected: the Supabase callback).';
  }
  if (/redirect.*not (allowed|registered|configured)|invalid redirect|url.*not allowed/i.test(desc)) {
    return 'Sign-in is not configured correctly yet. This redirect URL is not registered with the auth provider — please tell the administrator.';
  }
  if (/access_denied/.test(desc)) return 'Google sign-in was cancelled. You can close this page and try again.';
  if (/provider is not enabled|unsupported provider/i.test(desc)) {
    return 'Google sign-in is not enabled for this AURA AI account yet. Please contact your administrator, or sign in with email and password.';
  }
  if (/invalid_grant|expired|invalid code|code already/i.test(desc)) return 'Your sign-in session has expired. Please try signing in with Google again.';
  if (/server_error|temporarily_disabled|internal/i.test(desc)) return 'Google is temporarily unavailable. Please try again in a moment.';
  return desc || 'Something went wrong during sign-in.';
};

// Read OAuth params (error/error_description/error_code/code) from BOTH the
// query string and the URL fragment - older flows deliver errors in the hash.
const oauthParams = () => {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const get = (key) => params.get(key) || hashParams.get(key);
  return {
    error: get('error'),
    error_code: get('error_code'),
    error_description: get('error_description'),
    code: get('code'),
  };
};

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState('Completing sign-in...');

  const failWith = (text) => {
    setMessage(text);
    setTimeout(() => navigate('/login', { replace: true }), 3000);
  };

  useEffect(() => {
    let cancelled = false;

    const finish = async () => {
      try {
        const { error, error_code, error_description, code } = oauthParams();

        if (error || error_code) {
          if (!cancelled) failWith(oauthFriendly(error_description || error || error_code));
          return;
        }

        // getSession() waits for the SDK's initialisation, which already
        // processes the URL: an implicit-flow token fragment is persisted and
        // a PKCE `code` is exchanged automatically (detectSessionInUrl). Only
        // when no session appeared do we exchange a stray code ourselves.
        let session = (await supabase.auth.getSession()).data.session;

        if (!session && code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          // The SDK may already have redeemed the code (auto PKCE exchange).
          // Re-read the session instead of failing on a harmless double-use.
          if (exchangeError) {
            session = (await supabase.auth.getSession()).data.session;
            if (!session) throw exchangeError;
          } else {
            session = (await supabase.auth.getSession()).data.session;
          }
        }

        if (!session) throw new Error('No active session was found');

        if (!cancelled) {
          window.history.replaceState(null, '', window.location.pathname);
          navigate('/chat', { replace: true });
        }
      } catch (err) {
        if (!cancelled) failWith(oauthFriendly(err.message));
      }
    };

    finish();
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div className="auth-card" style={{ textAlign: 'center' }}>
      <div style={{ margin: '0 auto 16px', width: 40, height: 40, background: 'var(--accent)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Sparkles size={20} color="white" />
      </div>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>One moment...</h1>
      <p className="subtitle" style={{ marginBottom: 0 }}>{message}</p>
    </div>
  );
}