import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Sparkles, MailCheck } from 'lucide-react';
import GoogleButton, { OrDivider } from '../components/GoogleButton';

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const { register, continueWithGoogle } = useAuth();
  const navigate = useNavigate();
  const submittingRef = useRef(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setError('');
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    submittingRef.current = true;
    setLoading(true);
    const result = await register(name, email, password);
    submittingRef.current = false;
    setLoading(false);
    if (result && result.silent) return;
    if (result.success) {
      if (result.needsEmailConfirmation) {
        setNeedsConfirmation(true);
      } else {
        navigate('/chat');
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

  if (needsConfirmation) {
    return (
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div style={{
          width: 48, height: 48, background: 'rgba(34,197,94,0.15)', borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
        }}>
          <MailCheck size={24} color="var(--success)" />
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Check your email</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5, marginBottom: 20 }}>
          We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account, then come back here to sign in.
        </p>
        <Link to="/login" className="btn btn-primary" style={{ textDecoration: 'none' }}>Back to Sign In</Link>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <div style={{
          width: 40, height: 40, background: 'var(--accent)', borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Sparkles size={20} color="white" />
        </div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Create account</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>Get started with AURA AI</p>
        </div>
      </div>
      {error && <div className="error-msg">{error}</div>}
      <GoogleButton onClick={handleGoogle} loading={loading} />
      <OrDivider />
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="Your name" />
        </div>
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} placeholder="At least 6 characters" />
        </div>
        <div className="form-group">
          <label>Confirm Password</label>
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required minLength={6} placeholder="Repeat your password" />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Creating account...' : 'Create Account'}
        </button>
      </form>
      <div className="auth-footer">
        Already have an account? <Link to="/login">Sign in</Link>
      </div>
    </div>
  );
}