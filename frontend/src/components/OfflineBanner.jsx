import { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import useOnline from '../hooks/useOnline';

export default function OfflineBanner() {
  const online = useOnline();
  const [notice, setNotice] = useState(null);
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    if (online) {
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        setNotice('Back online — reconnecting');
        const t = setTimeout(() => setNotice(null), 3000);
        return () => clearTimeout(t);
      }
    } else {
      wasOfflineRef.current = true;
      setNotice(null);
    }
  }, [online]);

  const offline = !online;
  const visible = offline || notice != null;

  return (
    <div
      className={`offline-banner${visible ? ' visible' : ''}${offline ? ' offline' : notice ? ' ok' : ''}`}
      role="status"
      aria-live="polite"
    >
      <WifiOff size={14} />
      <span>{offline ? "You're offline — reconnecting automatically." : notice}</span>
    </div>
  );
}