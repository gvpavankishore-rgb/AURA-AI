import { Copy, Check, Download, FileText, Pencil, RefreshCw, CircleAlert, Volume2, Pause, Sparkles, ArrowDown } from 'lucide-react';
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo, lazy, Suspense } from 'react';
import ChatAvatar from './ChatAvatar';
import ActionPermissionCard from './ActionPermissionCard';
import DeveloperProfileCard from './DeveloperProfileCard';
import { useAuth } from '../context/AuthContext';
import { attachmentUrl, isImageAttachment } from '../services/api';
import useAutoScroll from '../hooks/useAutoScroll';
import SmartImage from './SmartImage';
import { createTtsSpeaker, STATE } from '../utils/ttsController';

const MarkdownContent = lazy(() => import('./MarkdownContent'));

const downloadAttachment = (att) => {
  const href = attachmentUrl(att);
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = 'aura-image.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

const getVoicesHydrated = () => {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try { window.speechSynthesis.getVoices(); } catch { /* ignore */ }
};

const pickTtsVoice = () => {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  getVoicesHydrated();
  let voices = [];
  try { voices = window.speechSynthesis.getVoices() || []; } catch { voices = []; }
  const priority = ['en-IN', 'en-US', 'en-GB', 'en'];
  for (const lang of priority) {
    const match = voices.find(v => String(v.lang || '').toLowerCase().startsWith(lang));
    if (match) return match;
  }
  return voices[0] || null;
};

const sourcesForMessage = (msg) => {
  if (msg.role !== 'assistant') return [];
  if (Array.isArray(msg.sources)) return msg.sources;
  const meta = msg.metadata || {};
  if (Array.isArray(meta.sources)) return meta.sources;
  if (Array.isArray(meta.webSearch?.sources)) return meta.webSearch.sources;
  return [];
};

const revealedContentIds = new Set();

function MessageBody({ msg, isLast, streaming }) {
  const attachmentsArr = Array.isArray(msg.attachments) ? msg.attachments : [];
  const images = attachmentsArr.filter(a => isImageAttachment(a) && attachmentUrl(a));
  const others = attachmentsArr.filter(a => !isImageAttachment(a));
  const sources = sourcesForMessage(msg);
  const revealContent = !!(
    msg.role === 'assistant' &&
    msg.content &&
    !msg.isError &&
    msg._id != null &&
    !revealedContentIds.has(msg._id)
  );
  if (revealContent) revealedContentIds.add(msg._id);

  if (msg.kind === 'action_confirmation' || msg.type === 'action_confirmation') {
    return (
      <div className="message-content">
        <ActionPermissionCard action={msg.action} />
      </div>
    );
  }

  return msg.isError ? (
    <div className="message-error">
      <div className="error-icon">
        <CircleAlert size={14} />
        Something went wrong
      </div>
      <div className="error-text">{msg.content}</div>
    </div>
  ) : (
    <div className={`message-content${revealContent ? ' content-reveal' : ''}`}>
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((att, i) => (
            <div key={i} className="msg-image-wrap">
              <SmartImage
                src={attachmentUrl(att)}
                alt=""
                className="msg-image"
                skeletonStyle={{ borderRadius: 12 }}
                referrerPolicy="no-referrer"
              />
              <button
                className="msg-image-download"
                onClick={() => downloadAttachment(att)}
                aria-label="Download image"
                title="Download image"
              >
                <Download size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <Suspense fallback={<div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>}>
        <MarkdownContent content={msg.content} />
      </Suspense>
      {sources.length > 0 && (
        <div className="sources-section">
          <div className="sources-title">Sources</div>
          <ul className="sources-list">
            {sources.map((s, i) => (
              <li key={i}>
                {s && s.url ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a>
                ) : (
                  <span>{s?.title || s?.url || 'Source'}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {msg.role === 'assistant' && (msg.developerProfile || msg.metadata?.developerProfile) && (
        <DeveloperProfileCard />
      )}
      {others.length > 0 && (
        <div className="attachment-list">
          {others.map((att, i) => (
            <span key={i} className="attachment-chip">
              <FileText size={12} />
              {att.filename || 'Attachment'}
            </span>
          ))}
        </div>
      )}
      {streaming && isLast && msg.role === 'assistant' && (
        <span className="streaming-cursor" />
      )}
      {!msg.content && streaming && isLast && msg.role === 'assistant' && (
        <div className="typing-indicator">
          <span /><span /><span />
        </div>
      )}
    </div>
  );
}

const MessageItem = memo(function MessageItem({ msg, isLast, streaming, user, onRegenerateFromMessage, onEditRequest, busy, onEnhanceImage, speaker, onToggleSpeak, appear }) {
  const [copied, setCopied] = useState(false);
  const animateIn = useRef(appear).current;
  const isActionCard = msg.kind === 'action_confirmation' || msg.type === 'action_confirmation';
  const userImages = msg.role === 'user' && Array.isArray(msg.attachments)
    ? msg.attachments.filter(a => isImageAttachment(a) && attachmentUrl(a))
    : [];
  const canSpeak = msg.role === 'assistant' && !msg.isError && Boolean(msg.content) && !msg.isEnhancing;

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`message-row ${msg.role}${animateIn ? ' message-appear' : ''}`}>
      <ChatAvatar
        type={msg.role}
        user={user}
        thinking={streaming && isLast && msg.role === 'assistant'}
      />
      <div className="message-main">
        <div className="message-bubble">
          <MessageBody msg={msg} isLast={isLast} streaming={streaming} />
        </div>

        {!isActionCard && (
          <div className="message-actions" role="toolbar" aria-label="Message actions">
            <button
              className={copied ? 'copied' : ''}
              onClick={handleCopy}
              aria-label="Copy message"
              title="Copy message"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
            {canSpeak && (
              <button
                onClick={() => onToggleSpeak?.(msg)}
                disabled={busy}
                aria-label={speaker.msgId === msg._id && speaker.state === 'playing' ? 'Pause speech' : 'Play response'}
                title={speaker.msgId === msg._id && speaker.state === 'playing' ? 'Pause speech' : 'Play response aloud'}
              >
                {speaker.msgId === msg._id && speaker.state === 'playing' ? (
                  <Pause size={13} />
                ) : (
                  <Volume2 size={13} />
                )}
                {speaker.msgId === msg._id && speaker.state === 'playing' ? 'Pause' : 'Play'}
              </button>
            )}
            {msg.role === 'user' && (
              <>
                {userImages.length > 0 && (
                  <button onClick={() => onEnhanceImage?.(msg)} disabled={busy} aria-label="Enhance image" title="Enhance image quality">
                    <Sparkles size={13} /> Enhance
                  </button>
                )}
                <button onClick={() => onEditRequest?.(msg._id)} disabled={busy} aria-label="Edit message" title="Edit message">
                  <Pencil size={13} /> Edit
                </button>
              </>
            )}
            {msg.role === 'assistant' && (
              <button
                onClick={() => onRegenerateFromMessage?.(msg._id)}
                disabled={busy}
                aria-label="Regenerate response"
                title="Regenerate response"
              >
                <RefreshCw size={13} /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/* -------------------- Virtualization -------------------- */

const ROW_GAP = 2;
const OVERSCAN = 8;
const INITIAL_END = 24;

function estimateRowHeight(msg) {
  const kind = msg.kind || msg.type;
  if (kind === 'action_confirmation') return 120;
  const content = String(msg.content || '');
  let h = 84;
  if (content) {
    const lines = content.split('\n').length;
    const longLines = Math.ceil(content.length / 110);
    h += Math.max(lines, longLines) * 24;
  }
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (atts.some(isImageAttachment)) h += 180;
  if (atts.some(a => !isImageAttachment(a))) h += 30;
  const sources = sourcesForMessage(msg);
  if (sources.length > 0) h += 28 + sources.length * 22;
  if (msg.developerProfile || msg.metadata?.developerProfile) h += 90;
  return Math.min(1600, Math.max(64, h));
}

function buildOffsets(messages, heights) {
  const n = messages.length;
  const offsets = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = acc;
    const msg = messages[i];
    const key = msg._id != null ? msg._id : i;
    const h = heights.get(key);
    acc += (typeof h === 'number' && h > 0 ? h : estimateRowHeight(msg)) + ROW_GAP;
  }
  return offsets;
}

function totalContentHeight(messages, offsets, heights) {
  if (offsets.length === 0) return 0;
  const msg = messages[messages.length - 1];
  const key = msg._id != null ? msg._id : messages.length - 1;
  const h = heights.get(key);
  return offsets[offsets.length - 1] + (typeof h === 'number' && h > 0 ? h : estimateRowHeight(msg)) + ROW_GAP;
}

function findStart(offsets, scrollTop) {
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= scrollTop) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

const VirtualRow = memo(function VirtualRow({ msg, rowKey, offset, isLast, streaming, user, busy, speaker, onToggleSpeak, onEditRequest, onRegenerateFromMessage, onEnhanceImage, onMeasured, appear, onConsumeAppear }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    if (appear && rowKey != null) onConsumeAppear(rowKey);
  }, [appear, rowKey, onConsumeAppear]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const report = () => {
      const h = Math.round(el.offsetHeight);
      if (h > 0) onMeasured(msg._id, h);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [msg._id, onMeasured]);

  return (
    <div className="virtual-row" style={{ transform: `translateY(${offset}px)` }} ref={ref}>
      <MessageItem
        msg={msg}
        isLast={isLast}
        streaming={streaming}
        user={user}
        busy={busy}
        speaker={speaker}
        onToggleSpeak={onToggleSpeak}
        onEditRequest={onEditRequest}
        onRegenerateFromMessage={onRegenerateFromMessage}
        onEnhanceImage={onEnhanceImage}
        appear={appear}
      />
    </div>
  );
});

export default function MessageList({ messages = [], streaming, loading, onEditRequest, onRegenerateFromMessage, onEnhanceImage, followToken = 0 }) {
  const { user } = useAuth();
  const busy = loading || streaming;
  const containerRef = useRef(null);
  const ttsRef = useRef(null);
  const heightsRef = useRef(new Map());
  const offsetsRef = useRef([]);
  const rangeRef = useRef({ start: 0, end: INITIAL_END });
  const appearSetRef = useRef(new Set());
  const prevMsgRef = useRef(null);
  const scrollRafRef = useRef(null);
  const revisionRafRef = useRef(null);
  const [revision, setRevision] = useState(0);
  const [range, setRange] = useState({ start: 0, end: INITIAL_END });
  const [speaker, setSpeaker] = useState({ msgId: null, state: 'idle', error: false });
  const { showScrollButton, scrollToBottom } = useAutoScroll(containerRef, { streaming, followToken });

  // One TTS controller owns the speechSynthesis session for this message list,
  // so Play / Pause / Resume always share the same queue, chunks, and position.
  const setSpeakerState = useCallback((msgId, state, error) => {
    setSpeaker({ msgId: msgId ?? null, state: state ?? 'idle', error: Boolean(error) });
  }, []);

  useEffect(() => {
    let tts = null;
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      tts = createTtsSpeaker({
        speechSynthesis: window.speechSynthesis,
        pickVoice: pickTtsVoice,
        onState: setSpeakerState,
      });
      ttsRef.current = tts;
    }
    return () => {
      tts?.destroy();
      ttsRef.current = null;
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, [setSpeakerState]);

  // If the message currently being read is removed (edited / regenerated), stop.
  useEffect(() => {
    if (!speaker.msgId) return;
    if (messages.some(m => m._id === speaker.msgId)) return;
    ttsRef.current?.stop();
    setSpeaker({ msgId: null, state: 'idle', error: false });
  }, [messages, speaker.msgId]);

  const toggleSpeak = useCallback((msg) => {
    if (typeof window === 'undefined' || !window.speechSynthesis || !ttsRef.current) {
      setSpeaker({ msgId: null, state: 'idle', error: true });
      return;
    }
    const tts = ttsRef.current;
    const currentState = speaker.msgId === msg._id ? speaker.state : STATE.IDLE;
    tts.toggle(msg._id, msg.content || '', currentState);
  }, [speaker]);

  const onMeasured = useCallback((key, height) => {
    if (height <= 0) return;
    const h = Math.round(height);
    if (heightsRef.current.get(key) === h) return;
    heightsRef.current.set(key, h);
    if (revisionRafRef.current) return;
    revisionRafRef.current = requestAnimationFrame(() => {
      revisionRafRef.current = null;
      setRevision(r => r + 1);
    });
  }, []);

  const onConsumeAppear = useCallback((key) => {
    appearSetRef.current.delete(key);
  }, []);

  const curIdsNow = messages.map(m => (m._id != null ? m._id : -1));
  const prevMsgs = prevMsgRef.current;
  if (prevMsgs !== null && prevMsgs !== messages) {
    const prevIds = new Set(prevMsgs.map(m => (m._id != null ? m._id : -1)));
    const overlap = curIdsNow.some(id => prevIds.has(id));
    if (curIdsNow.length > 0 && !overlap) {
      appearSetRef.current.clear();
    } else {
      for (const id of curIdsNow) {
        if (id !== -1 && !prevIds.has(id)) appearSetRef.current.add(id);
      }
    }
  }
  prevMsgRef.current = messages;

  const offsets = useMemo(
    () => buildOffsets(messages, heightsRef.current),
    [messages, revision]
  );
  offsetsRef.current = offsets;

  const totalHeight = totalContentHeight(messages, offsets, heightsRef.current);

  const recomputeRange = useCallback(() => {
    const el = containerRef.current;
    const offsetsArr = offsetsRef.current;
    if (!el || offsetsArr.length === 0) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    let start = findStart(offsetsArr, top);
    let end = start;
    const max = offsetsArr.length - 1;
    while (end < max && offsetsArr[end] < bottom) end += 1;
    end = Math.min(offsetsArr.length, Math.max(start + 1, end + 1));
    const next = {
      start: Math.max(0, start - OVERSCAN),
      end: Math.min(offsetsArr.length, end + OVERSCAN),
    };
    if (next.start !== rangeRef.current.start || next.end !== rangeRef.current.end) {
      rangeRef.current = next;
      setRange(next);
    }
  }, []);

  useLayoutEffect(() => {
    recomputeRange();
  }, [recomputeRange, revision, messages.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        recomputeRange();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [recomputeRange]);

  useEffect(() => () => {
    cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = null;
    if (revisionRafRef.current) {
      cancelAnimationFrame(revisionRafRef.current);
      revisionRafRef.current = null;
    }
  }, []);

  const count = messages.length;
  const visible = [];
  const endIdx = Math.min(range.end, count);
  const startIdx = Math.min(range.start, endIdx);
  for (let i = startIdx; i < endIdx; i++) visible.push(i);

  return (
    <div className="chat-area" ref={containerRef}>
      {speaker.error && speaker.msgId === null && (
        <div className="tts-notice">Text-to-speech is not supported in this browser.</div>
      )}
      {showScrollButton && (
        <button className="scroll-to-bottom-btn" onClick={() => scrollToBottom(true)} aria-label="Scroll to latest message">
          <ArrowDown size={14} /> Scroll to bottom
        </button>
      )}
      <div className="chat-container virtual">
        <div className="message-virtual-spacer" style={{ height: totalHeight }}>
          {visible.map(i => {
            const msg = messages[i];
            const rowKey = msg._id != null ? msg._id : i;
            return (
              <VirtualRow
                key={rowKey}
                rowKey={rowKey}
                msg={msg}
                offset={offsets[i] || 0}
                isLast={i === count - 1}
                streaming={streaming}
                user={user}
                busy={busy}
                speaker={speaker}
                onToggleSpeak={toggleSpeak}
                onEditRequest={onEditRequest}
                onRegenerateFromMessage={onRegenerateFromMessage}
                onEnhanceImage={onEnhanceImage}
                onMeasured={onMeasured}
                appear={appearSetRef.current.has(rowKey)}
                onConsumeAppear={onConsumeAppear}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}