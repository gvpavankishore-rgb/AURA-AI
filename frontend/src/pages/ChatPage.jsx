import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { Menu, Square, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import api, { attachmentUrl } from '../services/api';
import { useAuth } from '../context/AuthContext';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';
import AuthModal from '../components/AuthModal';
import { MessageSkeleton } from '../components/Skeleton';

const suggestions = [
  { text: 'Explain quantum computing', icon: '💡' },
  { text: 'Build a React component', icon: '⚛️' },
  { text: 'Write a Python script for data analysis', icon: '🐍' },
  { text: 'Summarize the key points of a document', icon: '📄' },
  { text: 'Translate this to Spanish', icon: '🌍' },
  { text: 'Debug my JavaScript code', icon: '🔧' },
];

const storedAttachment = (a) =>
  a && (a.id || a.path)
    ? { id: a.id, filename: a.filename, path: a.path, mimetype: a.mimetype, type: a.type }
    : null;

export default function ChatPage() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const { onMenuClick } = useOutletContext();
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [chat, setChat] = useState(null);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [pendingMessage, setPendingMessage] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [followToken, setFollowToken] = useState(0);
  const abortRef = useRef(false);
  const abortControllerRef = useRef(null);
  const streamingRef = useRef(false);
  const generationRef = useRef(0);
  const chatInputRef = useRef(null);
  const chatRef = useRef(null);
  const restoredForRef = useRef(null);
  const lastUserIdRef = useRef(null);
  const hasHydratedRef = useRef(false);
  const loadRidRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Per-user "last chat" key so switching accounts never restores another
  // user's (or a deleted) conversation id from localStorage.
  const lastChatKey = user ? `aura:last-chat:${user.id}` : 'aura:last-chat';

  useEffect(() => {
    chatRef.current = chat?._id || chatId || null;
    if (user) {
      const id = chatRef.current;
      if (id) localStorage.setItem(lastChatKey, id);
    }
  }, [chat, chatId, user, lastChatKey]);

  useEffect(() => {
    if (!user) restoredForRef.current = null;
  }, [user]);

  // React to the AUTHENTICATED user changing (sign out or direct account
  // switch) while this page is mounted. Clears any current-chat state so a
  // conversation from a previous account is never left visible, aborts an
  // in-flight stream, and navigates to a fresh chat home where the restore
  // effect below re-selects a valid conversation belonging to the NEW user.
  // A plain "guest -> signed in" transition is left untouched so the existing
  // pendingMessage/restore flow (e.g. sign in from the auth modal after typing
  // a message) keeps working.
  const userId = user?.id || null;
  useEffect(() => {
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true;
      lastUserIdRef.current = userId;
      return;
    }
    if (lastUserIdRef.current === userId) return;
    const wasSignedIn = Boolean(lastUserIdRef.current);
    lastUserIdRef.current = userId;

    const clearAccountState = () => {
      generationRef.current += 1;
      streamingRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setStreaming(false);
      setLoading(false);
      setHistoryLoading(false);
      setShowAuthModal(false);
      setChat(null);
      setMessages([]);
      setEditing(null);
      restoredForRef.current = null;
      chatRef.current = null;
      navigate('/chat', { replace: true });
    };

    if (!userId || wasSignedIn) {
      setPendingMessage(null);
      clearAccountState();
    }
  }, [userId, navigate]);

  useEffect(() => {
    const onNewChat = () => {
      generationRef.current += 1;
      streamingRef.current = false;
      setStreaming(false);
      setLoading(false);
      setShowAuthModal(false);
      setPendingMessage(null);
      chatRef.current = null;
      setChat(null);
      setMessages([]);
      setEditing(null);
      localStorage.removeItem(lastChatKey);
      localStorage.removeItem('aura:last-chat');
      chatInputRef.current?.clearDraft();
      navigate('/chat', { replace: true });
    };
    window.addEventListener('aura:new-chat', onNewChat);
    return () => window.removeEventListener('aura:new-chat', onNewChat);
  }, [navigate, lastChatKey]);

  const loadChat = useCallback(async (id) => {
    const rid = ++loadRidRef.current;
    setHistoryLoading(true);
    try {
      const res = await api.getChat(id);
      if (rid !== loadRidRef.current) return;
      if (res.success) {
        setChat(res.data.chat);
        setMessages(res.data.messages || []);
        setFollowToken(t => t + 1);
      } else {
        navigate('/chat');
      }
    } catch {
      if (rid !== loadRidRef.current) return;
      navigate('/chat');
    } finally {
      if (rid === loadRidRef.current) setHistoryLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (!chatId) {
      loadRidRef.current += 1;
      setMessages([]);
      setChat(null);
      setEditing(null);
      setHistoryLoading(false);
      return;
    }
    if (streamingRef.current) return;
    setMessages([]);
    setChat(null);
    setEditing(null);
    loadChat(chatId);
  }, [chatId, loadChat]);

  useEffect(() => {
    if (!user || chatId || pendingMessage) return;
    if (restoredForRef.current === user.id) return;
    restoredForRef.current = user.id;
    let cancelled = false;
    (async () => {
      try {
        // Only restore a bookmarked chat id that belongs to THIS user (the key
        // is scoped to the authenticated Supabase user id). A stale/deleted/other
        // user's id is simply ignored and gets cleaned up on load failure below.
        const stored = user ? localStorage.getItem(lastChatKey) : null;
        if (stored) {
          navigate(`/chat/${stored}`, { replace: true });
          return;
        }
        const res = await api.getChats();
        if (cancelled) return;
        if (res.success && res.data && res.data.length > 0) {
          const latest = res.data.reduce((a, b) =>
            new Date(b.updatedAt || b.createdAt || 0).getTime() > new Date(a.updatedAt || a.createdAt || 0).getTime() ? b : a
          );
          navigate(`/chat/${latest._id}`, { replace: true });
        } else {
          localStorage.removeItem(lastChatKey);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [user, lastChatKey, chatId, pendingMessage, navigate]);

  useEffect(() => {
    if (user && pendingMessage) {
      setShowAuthModal(false);
      const msg = pendingMessage;
      setPendingMessage(null);
      // Clear the composer only AFTER the message is actually sent. Clearing
      // first would revoke the attachment blob previews the message relies on
      // (they are not used for rendering anymore, but the composer must keep
      // the draft intact so a failed re-send can be retried after sign-in).
      handleSend(msg)
        .then((result) => {
          if (result && result.success) chatInputRef.current?.clearDraft();
        })
        .catch(() => {});
    }
  }, [user, pendingMessage]);

  const runStream = useCallback(async (payload) => {
    const gen = ++generationRef.current;
    setLoading(true);
    setStreaming(true);
    streamingRef.current = true;
    abortRef.current = false;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const tempAiMsg = {
      _id: 'streaming',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      isError: false,
      sources: [],
    };
    setMessages(prev => [...prev, tempAiMsg]);

    let fullContent = '';
    let sources = [];
    let actionReceived = false;
    let stopped = false;

    const finalizeAborted = () => {
      setMessages(prev => {
        const updated = [...prev];
        const idx = updated.findIndex(m => m._id === 'streaming');
        if (idx === -1) return updated;
        updated[idx] = {
          ...updated[idx],
          _id: 'msg-' + Date.now(),
          content: fullContent || 'Generation stopped.',
          isError: false,
        };
        return updated;
      });
    };

    await api.streamMessage(
      payload,
      {
        signal: controller.signal,
        onMeta: (meta) => {
          if (generationRef.current !== gen) return;
          if (meta.chatId) {
            setChat(prevChat => prevChat
              ? { ...prevChat, _id: meta.chatId, title: meta.title || prevChat.title }
              : { _id: meta.chatId, title: meta.title || 'New Chat' });
            if (chatRef.current !== meta.chatId) {
              chatRef.current = meta.chatId;
              navigate(`/chat/${meta.chatId}`, { replace: true });
            }
          }
          if (meta.userMessageId) {
            setMessages(prev => {
              const updated = [...prev];
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].role === 'user' && (updated[i]._id === 'streaming-user' || !/^[0-9a-fA-F]{24}$/.test(String(updated[i]._id)))) {
                  updated[i] = { ...updated[i], _id: meta.userMessageId };
                  break;
                }
              }
              return updated;
            });
          }
        },
        onDeveloper: () => {
          if (generationRef.current !== gen) return;
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx < 0) return updated;
            updated[lastIdx] = { ...updated[lastIdx], developerProfile: true };
            return updated;
          });
        },
        onAction: (actionReq) => {
          if (generationRef.current !== gen) return;
          actionReceived = true;
          const actionMsg = {
            _id: 'action-' + Date.now(),
            role: 'assistant',
            kind: 'action_confirmation',
            content: '',
            action: { ...actionReq },
            createdAt: new Date().toISOString(),
            isError: false,
          };
          setMessages(prev => {
            const updated = [...prev];
            const idx = updated.findIndex(m => m._id === 'streaming');
            if (idx !== -1) updated[idx] = actionMsg;
            else updated.push(actionMsg);
            return updated;
          });
        },
        onSources: (srcs) => {
          if (generationRef.current !== gen) return;
          sources = Array.isArray(srcs) ? srcs : [];
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx < 0) return updated;
            updated[lastIdx] = { ...updated[lastIdx], sources };
            return updated;
          });
        },
        onChunk: (chunk) => {
          if (generationRef.current !== gen) return;
          if (abortRef.current) return;
          fullContent += chunk;
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            updated[lastIdx] = { ...updated[lastIdx], content: fullContent, isError: false };
            return updated;
          });
        },
        onDone: () => {
          if (generationRef.current !== gen) return;
          streamingRef.current = false;
          setStreaming(false);
          setLoading(false);
          abortControllerRef.current = null;
          window.dispatchEvent(new CustomEvent('aura:history-updated'));
          if (actionReceived) return;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = {
              ...last,
              _id: last._id === 'streaming' ? 'msg-' + Date.now() : last._id,
              content: fullContent || 'No response received.',
              isError: !fullContent,
            };
            return updated;
          });
        },
        onAbort: () => {
          if (generationRef.current !== gen) return;
          stopped = true;
          streamingRef.current = false;
          setStreaming(false);
          setLoading(false);
          abortControllerRef.current = null;
          window.dispatchEvent(new CustomEvent('aura:history-updated'));
          if (actionReceived) return;
          finalizeAborted();
        },
        onError: (error) => {
          if (generationRef.current !== gen) return;
          streamingRef.current = false;
          setStreaming(false);
          setLoading(false);
          abortControllerRef.current = null;
          window.dispatchEvent(new CustomEvent('aura:history-updated'));
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: fullContent || error || 'Something went wrong while generating a response. Please try again.',
              isError: true,
              _id: 'error-' + Date.now(),
            };
            return updated;
          });
        },
      }
    );
  }, [chatRef, navigate, lastChatKey]);

  const handleSend = useCallback(async ({ content, attachments, regenerate = false, mode, editMessageId }) => {
    if (streamingRef.current) return { success: false, error: 'A response is already generating. Wait for it to finish or stop it first.' };

    const hasInput = Boolean(content && content.trim()) || Boolean(attachments && attachments.length > 0) || Boolean(editMessageId);
    if (!hasInput) return { success: false };

    if (!user) {
      setPendingMessage({ content, attachments });
      setShowAuthModal(true);
      return { success: false };
    }

    let finalContent = content || '';
    let finalAttachments = [];
    let failedIndexes = [];

    if (regenerate) {
      const lastUserMsg = [...messagesRef.current].reverse().find(m => m.role === 'user');
      if (!lastUserMsg) return { success: false };
      finalContent = lastUserMsg.content || '';
      finalAttachments = (Array.isArray(lastUserMsg.attachments) ? lastUserMsg.attachments : [])
        .map(storedAttachment)
        .filter(Boolean);
      if (!finalContent.trim() && finalAttachments.length === 0) return { success: false };
    } else {
      const docsAndImages = (attachments || []).filter(a => !a.isVoice);
      const voiceNotes = (attachments || []).filter(a => a.isVoice);

      if (editMessageId) {
        const target = messagesRef.current.find(m => m._id === editMessageId && m.role === 'user');
        if (target) {
          finalAttachments = (Array.isArray(target.attachments) ? target.attachments : [])
            .map(storedAttachment)
            .filter(Boolean);
        }
      }

      for (const voice of voiceNotes) {
        try {
          const res = await api.transcribeAudio(voice.file);
          if (res.success && res.data?.text) {
            finalContent = (finalContent.trim() + ' ' + res.data.text).trim();
          }
        } catch { /* transcription failed silently */ }
      }

      for (const att of docsAndImages) {
        try {
          const up = await api.uploadChatFile(att.file);
          if (up.success && up.data) finalAttachments.push({ ...up.data, preview: att.preview });
          else failedIndexes.push((attachments || []).indexOf(att));
        } catch {
          failedIndexes.push((attachments || []).indexOf(att));
        }
      }

      const validVox = voiceNotes.length > 0 && finalContent.trim().length > 0;
      if (!editMessageId && !finalContent.trim() && finalAttachments.length === 0 && !validVox) {
        setMessages(prev => [...prev, {
          _id: 'error-' + Date.now(),
          role: 'assistant',
          content: 'Could not process your attachment. Please try again.',
          isError: true,
          createdAt: new Date().toISOString(),
        }]);
      }
      // Never silently drop an attached image/file: if any of the newly added
      // uploads failed, hold the whole message and let the composer mark the
      // failed attachments for retry instead of sending a text-only message.
      if (failedIndexes.length > 0) {
        return { success: false, failures: failedIndexes, message: 'Some files could not be uploaded. Please retry or remove them below.' };
      }
    }

    if (editMessageId) {
      const idx = messagesRef.current.findIndex(m => m._id === editMessageId && m.role === 'user');
      if (idx === -1) return { success: false };
      if (!finalContent.trim() && finalAttachments.length === 0) {
        setEditing(null);
        return { success: false };
      }
      setMessages(prev => {
        const updated = prev.slice(0, idx + 1);
        updated[idx] = {
          ...updated[idx],
          content: finalContent,
          attachments: finalAttachments.map(sa => ({ id: sa.id, filename: sa.filename, type: sa.type, path: sa.path, mimetype: sa.mimetype })),
        };
        return updated;
      });
      setEditing(null);
      const payload = {
        conversationId: chatRef.current,
        content: finalContent,
        attachments: finalAttachments.map(({ preview, ...rest }) => ({ ...rest })),
        editMessageId,
        mode,
      };
      runStream(payload).catch(() => {});
      setFollowToken(t => t + 1);
      return { success: true };
    }

    if (!regenerate) {
      const tempUserMsg = {
        _id: 'streaming-user',
        role: 'user',
        content: finalContent,
        attachments: finalAttachments.map(a => ({ id: a.id, filename: a.filename, type: a.type, path: a.path, mimetype: a.mimetype })),
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, tempUserMsg]);
    }

    const payload = {
      conversationId: chatRef.current,
      content: finalContent,
      attachments: finalAttachments.map(({ preview, ...rest }) => ({ ...rest })),
      regenerate,
      mode,
    };

    runStream(payload).catch(() => {});
    setFollowToken(t => t + 1);

    return { success: true };
  }, [user, runStream]);

  const handleEnhanceImage = useCallback(async (msg) => {
    if (!user) { setShowAuthModal(true); return; }
    if (loading || streaming) return;
    const images = (Array.isArray(msg.attachments) ? msg.attachments : []).filter(a => attachmentUrl(a));
    if (!images.length) return;
    const enhId = 'enh-' + Date.now();
    setLoading(true);
    const tmpMsgId = 'enh-tmp-' + enhId;
    setMessages(prev => [...prev, {
      _id: tmpMsgId,
      role: 'assistant',
      content: 'Enhancing image…',
      isEnhancing: true,
      createdAt: new Date().toISOString(),
    }]);
    setFollowToken(t => t + 1);
    const results = [];
    try {
      for (const att of images) {
        const res = await fetch(attachmentUrl(att));
        if (!res.ok) throw new Error('Could not read the image.');
        const blob = await res.blob();
        const file = new File([blob], 'enhance.png', { type: blob.type || 'image/png' });
        const up = await api.enhanceImage(file, chatRef.current);
        if (!up.success) throw new Error(up.message || 'Enhancement failed.');
        results.push(up.data || {});
      }
      const chatId = results[0]?.chatId;
      if (chatId && chatRef.current !== chatId) {
        chatRef.current = chatId;
        setMessages(prev => prev.filter(m => m._id !== tmpMsgId));
        navigate(`/chat/${chatId}`, { replace: true });
        window.dispatchEvent(new CustomEvent('aura:history-updated'));
        return;
      }
      const assistantMsg = {
        _id: 'enh-ai-' + enhId,
        role: 'assistant',
        content: 'Enhanced image — higher resolution, sharper detail, and improved lighting, colors, and clarity.',
        attachments: results.map(r => ({ type: 'image', filename: '', path: r.path, mimetype: 'image/png' })),
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => prev.map(m => (m._id === tmpMsgId ? assistantMsg : m)));
      window.dispatchEvent(new CustomEvent('aura:history-updated'));
    } catch (err) {
      setMessages(prev => prev.map(m => (m._id === tmpMsgId
        ? { ...m, content: err.message || 'Enhancement failed.', isError: true }
        : m)));
    } finally {
      setLoading(false);
    }
  }, [user, loading, streaming]);

  const handleRegenerateFromMessage = useCallback((messageId) => {
    const idx = messagesRef.current.findIndex(m => m._id === messageId && m.role === 'assistant');
    if (idx === -1) return;
    if (loading || streaming) return;
    setMessages(prev => prev.slice(0, idx));
    handleSend({ content: '', attachments: [], regenerate: true });
  }, [loading, streaming, handleSend]);

  const handleEditRequest = useCallback((messageId) => {
    if (loading || streaming || streamingRef.current) return;
    const msg = messagesRef.current.find(m => m._id === messageId && m.role === 'user');
    if (!msg) return;
    setEditing({ msgId: msg._id, content: msg.content || '' });
    chatInputRef.current?.startEdit(msg.content || '');
  }, [loading, streaming]);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
    chatInputRef.current?.cancelEdit();
  }, []);

  const handleRetry = useCallback(() => {
    setMessages(prev => prev.filter(m => !m.isError && m._id !== 'streaming'));
    handleSend({ content: '', attachments: [], regenerate: true });
  }, [handleSend]);

  const handleRegenerate = useCallback(() => {
    setMessages(prev => prev.slice(0, -1));
    handleSend({ content: '', attachments: [], regenerate: true });
  }, [handleSend]);

  const handleStop = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    streamingRef.current = false;
    setStreaming(false);
    setLoading(false);
  }, []);

  const handleSuggestion = useCallback((text) => {
    chatInputRef.current?.setDraft(text);
  }, []);

  const lastMessage = messages[messages.length - 1];
  const showRetry = lastMessage?.isError && !loading && !streaming;
  const showRegenerate = !loading && !streaming && messages.length > 0 && !lastMessage?.isError && lastMessage?.role === 'assistant';

  return (
    <>
      <div className="topbar">
        <button className="menu-btn btn-ghost" onClick={onMenuClick}>
          <Menu size={18} />
        </button>
        <div className="topbar-title" aria-hidden="true" />
        <div className="topbar-actions">
          {!user && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowAuthModal(true)}
            >
              Sign In
            </button>
          )}
          {streaming && (
            <button onClick={handleStop} title="Stop generating" className="btn-ghost">
              <Square size={14} />
            </button>
          )}
        </div>
      </div>

      {messages.length === 0 ? (
        historyLoading ? (
          <MessageSkeleton count={4} />
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <Sparkles size={24} />
            </div>
            <h2>How can I help you today?</h2>
            <p>AURA can handle writing, analysis, coding, images, documents, translation, and more.</p>
            <div className="suggestion-grid">
              {suggestions.map((s, i) => (
                <button key={i} className="suggestion-card" onClick={() => handleSuggestion(s.text)}>
                  <span style={{ marginRight: 6 }}>{s.icon}</span>
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        )
      ) : (
        <>
          <MessageList
            messages={messages}
            streaming={streaming}
            loading={loading}
            followToken={followToken}
            onEditRequest={handleEditRequest}
            onRegenerateFromMessage={handleRegenerateFromMessage}
            onEnhanceImage={handleEnhanceImage}
          />
          {(showRetry || showRegenerate) && (
            <div className="chat-container" style={{ padding: '6px 0 14px', display: 'flex', gap: 6, justifyContent: 'center' }}>
              {showRetry && (
                <button className="btn btn-secondary btn-sm" onClick={handleRetry}>
                  <RotateCcw size={12} /> Retry
                </button>
              )}
              {showRegenerate && (
                <button className="btn btn-secondary btn-sm" onClick={handleRegenerate}>
                  <RefreshCw size={12} /> Regenerate
                </button>
              )}
            </div>
          )}
        </>
      )}

      <ChatInput
        ref={chatInputRef}
        onSend={handleSend}
        onStop={handleStop}
        loading={loading}
        editing={editing}
        onCancelEdit={handleCancelEdit}
        placeholder={user ? 'Ask AURA anything...' : 'Sign in to start chatting...'}
      />

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => { setShowAuthModal(false); setPendingMessage(null); }}
        onSuccess={() => {}}
      />
    </>
  );
}