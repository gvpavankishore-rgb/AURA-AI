import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Sparkles } from 'lucide-react';

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState('Completing sign-in...');

  const oauthFriendly = (description) => {
    const desc = String(description || '');
    if (/access_denied/.test(desc)) return 'Google sign-in was cancelled. You can close this page and try again.';
    if (/provider is not enabled|unsupported provider/i.test(desc)) {
      return 'Google sign-in is not enabled for this AURA AI account yet. Please contact your administrator, or sign in with email and password.';
    }
    if (/invalid_grant|expired|invalid code/i.test(desc)) return 'Your sign-in session has expired. Please try signing in with Google again.';
    if (/server_error|temporarily_disabled|internal/i.test(desc)) return 'Google is temporarily unavailable. Please try again in a moment.';
    return desc || 'Something went wrong during sign-in.';
  };

  const failWith = (text) => {
    setMessage(text);
    setTimeout(() => navigate('/login', { replace: true }), 3000);
  };

  useEffect(() => {
    let cancelled = false;

    const finish = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const error = params.get('error');
        const errorDescription = params.get('error_description');

        if (error) {
          if (!cancelled) failWith(oauthFriendly(errorDescription || error));
          return;
        }

        const code = params.get('code');
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
        }

        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!sessionData.session) throw new Error('No active session was found');

        if (!cancelled) navigate('/chat', { replace: true });
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