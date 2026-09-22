import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { Menu, Square, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import api, { uploadUrl } from '../services/api';
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

const attachmentUrl = (att) => att?.preview || (att?.path ? uploadUrl(att.path) : '');

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
  const abortRef = useRef(false);
  const abortControllerRef = useRef(null);
  const streamingRef = useRef(false);
  const generationRef = useRef(0);
  const chatInputRef = useRef(null);
  const chatRef = useRef(null);
  const restoredForRef = useRef(null);
  const loadRidRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const LAST_CHAT_KEY = 'aura:last-chat';

  useEffect(() => {
    chatRef.current = chat?._id || chatId || null;
    if (user) {
      const id = chatRef.current;
      if (id) localStorage.setItem(LAST_CHAT_KEY, id);
    }
  }, [chat, chatId, user, LAST_CHAT_KEY]);

  useEffect(() => {
    if (!user) restoredForRef.current = null;
  }, [user]);

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
      localStorage.removeItem(LAST_CHAT_KEY);
      chatInputRef.current?.clearDraft();
      navigate('/chat', { replace: true });
    };
    window.addEventListener('aura:new-chat', onNewChat);
    return () => window.removeEventListener('aura:new-chat', onNewChat);
  }, [navigate]);

  const loadChat = useCallback(async (id) => {
    const rid = ++loadRidRef.current;
    setHistoryLoading(true);
    try {
      const res = await api.getChat(id);
      if (rid !== loadRidRef.current) return;
      if (res.success) {
        setChat(res.data.chat);
        setMessages(res.data.messages || []);
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
      setHistoryLoading(false);
      return;
    }
    if (streamingRef.current) return;
    loadChat(chatId);
  }, [chatId, loadChat]);

  useEffect(() => {
    if (!user || chatId || pendingMessage) return;
    if (restoredForRef.current === user.id) return;
    restoredForRef.current = user.id;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getChats();
        if (cancelled) return;
        if (res.success && res.data && res.data.length > 0) {
          const stored = localStorage.getItem(LAST_CHAT_KEY);
          if (stored && res.data.some(c => c._id === stored)) {
            navigate(`/chat/${stored}`, { replace: true });
            return;
          }
          const latest = res.data.reduce((a, b) =>
            new Date(b.updatedAt || b.createdAt || 0).getTime() > new Date(a.updatedAt || a.createdAt || 0).getTime() ? b : a
          );
          navigate(`/chat/${latest._id}`, { replace: true });
        } else {
          localStorage.removeItem(LAST_CHAT_KEY);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [user, chatId, pendingMessage, navigate, LAST_CHAT_KEY]);

  useEffect(() => {
    if (user && pendingMessage) {
      setShowAuthModal(false);
      const msg = pendingMessage;
      setPendingMessage(null);
      chatInputRef.current?.clearDraft();
      handleSend(msg);
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
  }, [chatRef, navigate, LAST_CHAT_KEY]);

  const handleSend = useCallback(async ({ content, attachments, regenerate = false, mode }) => {
    const hasInput = Boolean(content && content.trim()) || Boolean(attachments && attachments.length > 0);
    if (!hasInput) return { success: false };

    if (!user) {
      setPendingMessage({ content, attachments });
      setShowAuthModal(true);
      return { success: false };
    }

    let finalContent = content || '';
    let finalAttachments = [];

    if (regenerate) {
      const lastUserMsg = [...messagesRef.current].reverse().find(m => m.role === 'user');
      if (!lastUserMsg) return { success: false };
      finalContent = lastUserMsg.content || '';
      finalAttachments = (Array.isArray(lastUserMsg.attachments) ? lastUserMsg.attachments : [])
        .filter(a => a.id || a.path)
        .map(a => ({ id: a.id, filename: a.filename, path: a.path, mimetype: a.mimetype, type: a.type }));
      if (!finalContent.trim() && finalAttachments.length === 0) return { success: false };
    } else if (attachments && attachments.length > 0) {
      const docsAndImages = attachments.filter(a => !a.isVoice);
      const voiceNotes = attachments.filter(a => a.isVoice);
      const failedIndexes = [];

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
          if (up.success && up.data) finalAttachments.push(up.data);
          else failedIndexes.push(attachments.indexOf(att));
        } catch {
          failedIndexes.push(attachments.indexOf(att));
        }
      }

      const validVox = voiceNotes.length > 0 && finalContent.trim().length > 0;
      if (!finalContent.trim() && finalAttachments.length === 0 && !validVox) {
        setMessages(prev => [...prev, {
          _id: 'error-' + Date.now(),
          role: 'assistant',
          content: 'Could not process your attachment. Please try again.',
          isError: true,
          createdAt: new Date().toISOString(),
        }]);
        return { success: false, failures: failedIndexes };
      }
    }

    if (!regenerate) {
      const tempUserMsg = {
        _id: Date.now().toString(),
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
      attachments: finalAttachments,
      regenerate,
      mode,
    };

    runStream(payload).catch(() => {});

    return { success: true };
  }, [user, runStream]);

  const handleGenerateImage = async (prompt) => {
    const trimmed = String(prompt || '').trim();
    if (!trimmed) return { ok: false };
    if (!user) {
      setPendingMessage({ content: trimmed });
      setShowAuthModal(true);
      return { ok: false };
    }
    if (loading || streaming) return { ok: false };
    const genId = 'img-' + Date.now();
    setLoading(true);
    try {
      const genUserMsg = {
        _id: 'gen-user-' + genId,
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, genUserMsg]);
      const res = await api.generateImage({ prompt: trimmed, conversationId: chatRef.current });
      if (!res.success) throw new Error(res.message || 'Image generation failed.');
      const data = res.data || {};
      const image = data.image;
      if (!image) throw new Error('No image was generated.');
      const chatId = data.chatId;
      if (chatId && chatRef.current !== chatId) {
        chatRef.current = chatId;
        navigate(`/chat/${chatId}`, { replace: true });
        window.dispatchEvent(new CustomEvent('aura:history-updated'));
        return { ok: true };
      }
      const mediaType = data.mediaType || 'image/png';
      const assistantMsg = {
        _id: 'gen-ai-' + genId,
        role: 'assistant',
        content: data.revisedPrompt || trimmed,
        attachments: [{ type: 'image', filename: '', preview: `data:${mediaType};base64,${image}`, generated: true }],
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, assistantMsg]);
      window.dispatchEvent(new CustomEvent('aura:history-updated'));
      return { ok: true };
    } catch (err) {
      setMessages(prev => [...prev, {
        _id: 'gen-err-' + Date.now(),
        role: 'assistant',
        content: err.message || 'Image generation failed.',
        isError: true,
        createdAt: new Date().toISOString(),
      }]);
      return { ok: false };
    } finally {
      setLoading(false);
    }
  };

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
    const msg = messagesRef.current.find(m => m._id === messageId && m.role === 'user');
    if (!msg) return;
    chatInputRef.current?.setDraft(msg.content || '');
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
    handleSend({ content: text });
  }, [handleSend]);

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
        onGenerateImage={handleGenerateImage}
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