import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check, Download, FileText, Pencil, RefreshCw, CircleAlert, Volume2, Pause, Sparkles, ArrowDown } from 'lucide-react';
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo } from 'react';
import ChatAvatar from './ChatAvatar';
import ActionPermissionCard from './ActionPermissionCard';
import DeveloperProfileCard from './DeveloperProfileCard';
import { useAuth } from '../context/AuthContext';
import { uploadUrl } from '../services/api';
import useAutoScroll from '../hooks/useAutoScroll';
import SmartImage from './SmartImage';

const messageUrl = (att) => {
  if (att.preview) return att.preview;
  if (att.path) return uploadUrl(att.path);
  return '';
};

const downloadAttachment = (att) => {
  const href = messageUrl(att);
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = 'aura-image.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// Convert markdown to clean text for speech. Strips code blocks, inline code,
// emphasis/heading/list markers, markdown links, images, URLs, and collapses to
// a single line, so speechSynthesis never reads "hash-hash-bold asterisk".
const stripMarkdownForSpeech = (text) => {
  let clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' Code omitted. ')
    .replace(/`([^`]*)`/g, '$1 ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1 ')
    .replace(/^#{1,6}\s*/gm, ' ')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, ' ')
    .replace(/[*_~>|]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Avoid speaking raw JSON / metadata blobs - summarize instead.
  const stripped = clean;
  if (stripped.startsWith('{') && stripped.includes('}') && (stripped.includes('":"') || stripped.includes("':'") || stripped.includes('":'))) {
    clean = 'The response contains structured data. Please view it in the chat.';
  }

  return clean.slice(0, 3500);
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

const CodeBlock = memo(function CodeBlock({ language, children }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([children], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code.${language || 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language || 'code'}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={handleCopy}>
            {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
          </button>
          <button onClick={handleDownload}>
            <Download size={11} /> Save
          </button>
        </div>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={language || 'text'}
        PreTag="div"
        customStyle={{ margin: 0, background: 'var(--bg-primary)', fontSize: '12.5px', overflowX: 'auto' }}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
});

const MarkdownContent = memo(function MarkdownContent({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ node, inline, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          if (!inline && (match || String(children).includes('\n'))) {
            return <CodeBlock language={match?.[1]}>{String(children).replace(/\n$/, '')}</CodeBlock>;
          }
          return <code className={className} {...props}>{children}</code>;
        },
        table({ node, children, ...props }) {
          return (
            <div className="table-scroll">
              <table {...props}>{children}</table>
            </div>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

const isImageAttachment = (a) =>
  a.type === 'image' ||
  /^image\//.test(a.type || '') ||
  (a.mimetype && a.mimetype.startsWith('image/'));

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
  const images = attachmentsArr.filter(a => isImageAttachment(a) && messageUrl(a));
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
                src={messageUrl(att)}
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
      <MarkdownContent content={msg.content} />
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
    ? msg.attachments.filter(a => isImageAttachment(a) && messageUrl(a))
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
                aria-label={speaker.msgId === msg._id && speaker.state === 'playing' ? 'Stop playback' : 'Play response'}
                title={speaker.msgId === msg._id && speaker.state === 'playing' ? 'Stop playback' : 'Play response aloud'}
              >
                {speaker.msgId === msg._id && speaker.state === 'playing' ? (
                  <Pause size={13} />
                ) : (
                  <Volume2 size={13} />
                )}
                {speaker.msgId === msg._id && speaker.state === 'playing' ? 'Stop'
                  : speaker.msgId === msg._id && speaker.state === 'stopped' ? 'Replay'
                    : 'Play'}
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

export default function MessageList({ messages = [], streaming, loading, onEditRequest, onRegenerateFromMessage, onEnhanceImage }) {
  const { user } = useAuth();
  const busy = loading || streaming;
  const containerRef = useRef(null);
  const utteranceRef = useRef(null);
  const heightsRef = useRef(new Map());
  const offsetsRef = useRef([]);
  const rangeRef = useRef({ start: 0, end: INITIAL_END });
  const appearSetRef = useRef(new Set());
  const prevMsgRef = useRef(null);
  const scrollRafRef = useRef(null);
  const [revision, setRevision] = useState(0);
  const [range, setRange] = useState({ start: 0, end: INITIAL_END });
  const [speaker, setSpeaker] = useState({ msgId: null, state: 'idle', error: false });
  const { showScrollButton, scrollToBottom } = useAutoScroll(containerRef, streaming);

  // Stop any active speech when the message list unmounts or a new chat loads.
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const toggleSpeak = useCallback((msg) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      setSpeaker({ msgId: null, state: 'idle', error: true });
      return;
    }
    const synth = window.speechSynthesis;

    // Same message currently playing -> stop it.
    if (speaker.msgId === msg._id && speaker.state === 'playing') {
      synth.cancel();
      utteranceRef.current = null;
      setSpeaker({ msgId: msg._id, state: 'stopped', error: false });
      return;
    }

    // Anything new (or replay) -> cancel the current utterance first so we
    // never speak two messages at once. A short delay after cancel() keeps
    // Chromium from silently discarding the replacement utterance.
    synth.cancel();
    utteranceRef.current = null;
    setSpeaker({ msgId: msg._id, state: 'playing', error: false });

    const text = stripMarkdownForSpeech(msg.content);
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickTtsVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang || 'en-US';
    } else {
      utterance.lang = 'en-US';
    }
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onstart = () => {
      if (utteranceRef.current === utterance) {
        setSpeaker(s => s.msgId === msg._id ? { msgId: msg._id, state: 'playing', error: false } : s);
      }
    };
    utterance.onend = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        setSpeaker(s => s.msgId === msg._id ? { msgId: msg._id, state: 'stopped', error: false } : s);
      }
    };
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        setSpeaker({ msgId: msg._id, state: 'idle', error: true });
      }
    };

    setTimeout(() => {
      // If the user stopped in the gap, don't start now.
      if (utteranceRef.current !== utterance) return;
      // Ensure voices are hydrated on Chromium before speaking.
      getVoicesHydrated();
      utteranceRef.current = utterance;
      synth.speak(utterance);
    }, 60);
  }, [speaker]);

  const onMeasured = useCallback((key, height) => {
    if (height <= 0) return;
    const h = Math.round(height);
    if (heightsRef.current.get(key) === h) return;
    heightsRef.current.set(key, h);
    setRevision(r => r + 1);
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
  }, []);

  const count = messages.length;
  const visible = [];
  const endIdx = Math.min(range.end, count);
  const startIdx = Math.min(range.start, endIdx);
  for (let i = startIdx; i < endIdx; i++) visible.push(i);

  return (
    <div className="chat-area" ref={containerRef}>
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