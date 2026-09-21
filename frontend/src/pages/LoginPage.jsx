import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Sparkles } from 'lucide-react';
import GoogleButton, { OrDivider } from '../components/GoogleButton';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, continueWithGoogle } = useAuth();
  const navigate = useNavigate();
  const submittingRef = useRef(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setError('');
    submittingRef.current = true;
    setLoading(true);
    const result = await login(email, password);
    submittingRef.current = false;
    setLoading(false);
    if (result && result.silent) return;
    if (result.success) navigate('/chat');
    else setError(result.message);
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
    <div className="auth-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <div style={{
          width: 40, height: 40, background: 'var(--accent)', borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Sparkles size={20} color="white" />
        </div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Welcome back</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>Sign in to AURA AI</p>
        </div>
      </div>
      {error && <div className="error-msg">{error}</div>}
      <GoogleButton onClick={handleGoogle} loading={loading} />
      <OrDivider />
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Your password" />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
      <div className="auth-footer">
        Don't have an account? <Link to="/register">Sign up</Link>
      </div>
    </div>
  );
}