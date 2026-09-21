import { useState } from 'react';
import { ShieldQuestion, ShieldCheck, ExternalLink } from 'lucide-react';
import { findSiteByAction } from '../utils/actions';

export default function ActionPermissionCard({ action }) {
  const [state, setState] = useState('pending');

  const site = findSiteByAction(action);
  const isSafe = Boolean(site);
  const label = action?.label || 'this page';
  const url = action?.url || '';

  const handleAllow = () => {
    if (state !== 'pending') return;
    if (!isSafe || !url) {
      setState('denied');
      return;
    }
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    setState(win ? 'allowed' : 'blocked');
  };

  const handleDeny = () => {
    if (state !== 'pending') return;
    setState('denied');
  };

  return (
    <div className="permission-card" role="alertdialog" aria-label={`Open ${label}`}>
      <div className="permission-head">
        <span className="permission-icon">
          {state === 'allowed' ? <ShieldCheck size={18} /> : <ShieldQuestion size={18} />}
        </span>
        <span className="permission-title">Open {label}?</span>
      </div>

      {state === 'pending' && (
        <>
          <p className="permission-body">AURA wants to open {label} in a new browser tab.</p>
          <div className="permission-actions">
            <button className="permission-btn deny" onClick={handleDeny} aria-label={`Don't open ${label}`}>
              Deny
            </button>
            <button className="permission-btn allow" onClick={handleAllow} aria-label={`Open ${label}`}>
              Allow
            </button>
          </div>
        </>
      )}

      {state === 'allowed' && (
        <p className="permission-body success">
          Opening {label}...
        </p>
      )}

      {state === 'blocked' && (
        <>
          <p className="permission-body warn">
            Your browser blocked the new tab. Click Open {label} to continue.
          </p>
          <div className="permission-actions">
            <a className="permission-btn allow as-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${label}`}>
              <ExternalLink size={14} /> Open {label}
            </a>
          </div>
        </>
      )}

      {state === 'denied' && (
        <p className="permission-body">Okay, I didn't open {label}.</p>
      )}
    </div>
  );
}