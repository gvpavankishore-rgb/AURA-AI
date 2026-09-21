import { useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Sparkles, X, MailCheck } from 'lucide-react';
import GoogleButton, { OrDivider } from './GoogleButton';

export default function AuthModal({ isOpen, onClose, mode: initialMode = 'login', onSuccess }) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const { login, register, continueWithGoogle } = useAuth();
  const submittingRef = useRef(false);

  if (!isOpen) return null;

  const resetForm = () => { setName(''); setEmail(''); setPassword(''); setConfirmPassword(''); setError(''); setNeedsConfirmation(false); };
  const switchMode = (m) => { resetForm(); setMode(m); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setError('');
    if (mode === 'register') {
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
      if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    }
    submittingRef.current = true;
    setLoading(true);
    const result = mode === 'login'
      ? await login(email, password)
      : await register(name, email, password);
    submittingRef.current = false;
    setLoading(false);
    if (result && result.silent) return;
    if (result.success) {
      if (result.needsEmailConfirmation) {
        setNeedsConfirmation(true);
      } else {
        resetForm();
        onSuccess?.();
        onClose();
      }
    } else {
      setError(result.message);
    }
  };

  const handleGoogle = async () => {
    if (submittingRef.current) return;
    setError('');
    submittingRef.current = true;
    setLoading(true);
    const result = await continueWithGoogle();
    if (result && !result.success) {
      submittingRef.current = false;
      setLoading(false);
      if (!result.silent) setError(result.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, background: 'var(--accent)', borderRadius: 'var(--radius-sm)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Sparkles size={18} color="white" />
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 0 }}>
                {needsConfirmation ? 'Check your email' : (mode === 'login' ? 'Welcome back' : 'Create account')}
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>
                {needsConfirmation ? '' : (mode === 'login' ? 'Sign in to continue to AURA AI' : 'Get started with AURA AI')}
              </p>
            </div>
          </div>
          <button onClick={() => { resetForm(); onClose(); }} className="btn-ghost" style={{ marginTop: -2 }}>
            <X size={16} />
          </button>
        </div>

        {needsConfirmation ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 44, height: 44, background: 'rgba(34,197,94,0.15)', borderRadius: 'var(--radius-sm)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
            }}>
              <MailCheck size={22} color="var(--success)" />
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
              We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account.
            </p>
            <button className="btn btn-secondary btn-sm" onClick={() => resetForm()} style={{ width: '100%' }}>Back</button>
          </div>
        ) : (
          <>
            {error && <div className="error-msg" style={{ marginBottom: 14 }}>{error}</div>}
            <GoogleButton onClick={handleGoogle} loading={loading} />
            <OrDivider margin="14px 0" />
            <form onSubmit={handleSubmit}>
              {mode === 'register' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 5, color: 'var(--text-secondary)' }}>Name</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="Your name" />
                </div>
              )}
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 5, color: 'var(--text-secondary)' }}>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 5, color: 'var(--text-secondary)' }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} placeholder="At least 6 characters" />
              </div>
              {mode === 'register' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 5, color: 'var(--text-secondary)' }}>Confirm Password</label>
                  <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required minLength={6} placeholder="Repeat your password" />
                </div>
              )}
              <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%', marginTop: 6 }}>
                {loading ? (mode === 'login' ? 'Signing in...' : 'Creating account...') : (mode === 'login' ? 'Sign In' : 'Create Account')}
              </button>
            </form>
            <div style={{ marginTop: 16, textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)' }}>
              {mode === 'login' ? (
                <>No account? <button onClick={() => switchMode('register')} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>Sign up</button></>
              ) : (
                <>Have an account? <button onClick={() => switchMode('login')} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>Sign in</button></>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}