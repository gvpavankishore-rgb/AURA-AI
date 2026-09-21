import { memo } from 'react';

export const Skeleton = memo(function Skeleton({ className = '', style }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
});

export const ChatListSkeleton = memo(function ChatListSkeleton({ count = 6 }) {
  return (
    <div className="sidebar-chat-skeleton" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="sidebar-chat-skeleton-row">
          <Skeleton className="sk-icon" />
          <Skeleton className="sk-line" style={{ width: `${60 + ((i * 7) % 30)}%` }} />
          <Skeleton className="sk-thumb" />
        </div>
      ))}
    </div>
  );
});

export const MessageSkeleton = memo(function MessageSkeleton({ count = 3 }) {
  return (
    <div className="chat-skeleton" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => {
        const user = i === 0;
        return (
          <div key={i} className={`msg-skeleton-row ${user ? 'user' : 'assistant'}`}>
            <Skeleton className="msg-skeleton-avatar" />
            <div className="msg-skeleton-body">
              <div className="msg-skeleton-bubble">
                <Skeleton className="msg-skeleton-line" style={{ width: user ? 170 : 220 }} />
                <Skeleton className="msg-skeleton-line" style={{ width: user ? 120 : 300 }} />
                {i === 2 && <Skeleton className="msg-skeleton-line" style={{ width: 140 }} />}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

export const FeaturePageSkeleton = memo(function FeaturePageSkeleton({ cards = 2 }) {
  return (
    <div className="feature-page-skeleton" aria-hidden="true">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="feature-card-skeleton">
          <Skeleton className="sk-h" style={{ width: `${30 + i * 10}%` }} />
          <Skeleton className="sk-row" />
          <Skeleton className="sk-row" style={{ width: '85%' }} />
          <Skeleton className="sk-row" style={{ width: '92%' }} />
          <Skeleton className="sk-control" style={{ width: '100%' }} />
          <Skeleton className="sk-btn" />
        </div>
      ))}
    </div>
  );
});

export const AppShellSkeleton = memo(function AppShellSkeleton() {
  return (
    <div className="main-layout loading-shell" aria-hidden="true">
      <div className="sidebar">
        <div className="sidebar-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Skeleton style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)' }} />
            <Skeleton style={{ width: 90, height: 14 }} />
          </div>
        </div>
        <div className="sidebar-new-chat">
          <Skeleton style={{ width: '100%', height: 34 }} />
        </div>
        <div className="sidebar-nav">
          <Skeleton style={{ width: '100%', height: 34 }} />
        </div>
        <ChatListSkeleton count={5} />
      </div>
      <div className="main-area">
        <div className="topbar">
          <Skeleton style={{ width: 180, height: 14 }} />
        </div>
        <div className="chat-area">
          <MessageSkeleton count={3} />
        </div>
      </div>
    </div>
  );
});

export const AuthCardSkeleton = memo(function AuthCardSkeleton() {
  return (
    <div className="auth-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Skeleton style={{ width: 40, height: 40, borderRadius: 'var(--radius-sm)' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton style={{ width: 150, height: 16 }} />
          <Skeleton style={{ width: 110, height: 12 }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Skeleton style={{ width: '100%', height: 40 }} />
        <Skeleton style={{ width: '100%', height: 40 }} />
        <Skeleton style={{ width: '100%', height: 40 }} />
        <Skeleton style={{ width: '100%', height: 42, borderRadius: 'var(--radius-sm)' }} />
      </div>
    </div>
  );
});