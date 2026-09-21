import { Component, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import MainLayout from './layouts/MainLayout';
import AuthLayout from './layouts/AuthLayout';
import AuthCallbackPage from './pages/AuthCallbackPage';
import ChatPage from './pages/ChatPage';
import LoadingScreen from './components/LoadingScreen';
import OfflineBanner from './components/OfflineBanner';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const DocumentsPage = lazy(() => import('./pages/DocumentsPage'));
const TranslatePage = lazy(() => import('./pages/TranslatePage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '', error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || String(error), error };
  }

  componentDidCatch(error, info) {
    console.error('[AURA] App error:', error, info?.componentStack || '');
  }

  handleReload = () => {
    window.location.reload();
  };

  handleRetry = () => {
    this.setState({ hasError: false, message: '', error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="loading-screen" style={{ flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 340, textAlign: 'center', lineHeight: 1.5 }}>
            An unexpected error occurred. Your chats are safe. Try resuming, or refresh to restart.
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              maxWidth: 420,
              padding: '6px 10px',
              background: 'rgba(127, 127, 127, 0.1)',
              borderRadius: 6,
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              textAlign: 'left',
            }}
          >
            {this.state.message || 'Unknown error (see browser console for details).'}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={this.handleRetry}>Try again</button>
            <button className="btn" onClick={this.handleReload}>Refresh</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function GuestRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (user) return <Navigate to="/chat" replace />;
  return children;
}

function AppRoutes() {
  const { loading } = useAuth();
  if (loading) return <LoadingScreen />;

  return (
    <Routes>
      <Route path="/auth/callback" element={<AuthCallbackPage />} />

      <Route element={<GuestRoute><AuthLayout /></GuestRoute>}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/signup" element={<RegisterPage />} />
      </Route>

      <Route element={<MainLayout />}>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:chatId" element={<ChatPage />} />
        <Route path="/documents" element={<ProtectedRoute><DocumentsPage /></ProtectedRoute>} />
        <Route path="/translate" element={<ProtectedRoute><TranslatePage /></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
      </Route>

      <Route path="/" element={<Navigate to="/chat" replace />} />
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <OfflineBanner />
        <AuthProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}