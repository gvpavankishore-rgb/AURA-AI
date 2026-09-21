import { useId } from 'react';
import SmartImage from './SmartImage';

const getInitials = (name = '') => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() || '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

function AuraOrb() {
  const gradId = useId();
  return (
    <svg className="aura-orb-svg" viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="50%" stopColor="#7c5cfc" />
          <stop offset="100%" stopColor="#5b3fd6" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="19" fill={`url(#${gradId})`} stroke="rgba(255, 255, 255, 0.35)" strokeWidth="1" />
      <circle cx="20" cy="20" r="15.5" fill="rgba(255, 255, 255, 0.09)" />
      <path
        className="aura-spark"
        d="M20 12.5 L21.75 18.25 L27.5 20 L21.75 21.75 L20 27.5 L18.25 21.75 L12.5 20 L18.25 18.25 Z"
        fill="rgba(255, 255, 255, 0.96)"
      />
      <circle cx="27.5" cy="15" r="1.4" fill="rgba(255, 255, 255, 0.85)" />
      <circle cx="14" cy="25.5" r="1" fill="rgba(255, 255, 255, 0.6)" />
    </svg>
  );
}

export default function ChatAvatar({ type, user, thinking }) {
  if (type === 'assistant') {
    return (
      <div className={`message-avatar avatar-aura${thinking ? ' thinking' : ''}`} role="img" aria-label="AURA AI">
        <AuraOrb />
      </div>
    );
  }

  const avatarUrl = user?.avatar;
  if (avatarUrl) {
    return (
      <div className="message-avatar avatar-user" aria-label="User">
        <SmartImage src={avatarUrl} alt="User profile" mini containerClassName="smart-image-fill" />
      </div>
    );
  }

  const initials = user ? getInitials(user.name) : '';
  if (initials) {
    return (
      <div className="message-avatar avatar-user" aria-label="User">
        <span className="ava-initials">{initials}</span>
      </div>
    );
  }

  return (
    <div className="message-avatar avatar-user avatar-guest" aria-label="User">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}