import { useState, useRef, useEffect, forwardRef, useImperativeHandle, lazy, Suspense } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import {
  Plus, Mic, Square, Image as ImageIcon, FileUp, Camera, ArrowLeftRight,
  FileText, Languages, ArrowUp, X, AudioLines, AlertTriangle, Wand2, Braces,
} from 'lucide-react';
import api from '../services/api';
import SmartImage from './SmartImage';
import { compressImage } from '../utils/image';

const CameraOverlay = lazy(() => import('./ImageTools').then(m => ({ default: m.CameraOverlay })));
const ImagePreviewOverlay = lazy(() => import('./ImageTools').then(m => ({ default: m.ImagePreviewOverlay })));

const translateTargets = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ta', name: 'Tamil' },
  { code: 'tr', name: 'Turkish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'pl', name: 'Polish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
];

const languageLabel = l => (l.nativeName ? `${l.name} (${l.nativeName})` : l.name);

const DRAFT_KEY = 'aura:chat-draft';

const SUPPORTED_PASTE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

const ChatInput = forwardRef(function ChatInput({ onSend, onStop, loading, placeholder, onGenerateImage }, ref) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [recording, setRecording] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [translateMode, setTranslateMode] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('es');
  const [previewUrl, setPreviewUrl] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [imageGenerationMode, setImageGenerationMode] = useState(false);
  const [codingMode, setCodingMode] = useState(false);
  const textareaRef = useRef(null);
  const dragDepth = useRef(0);

  useImperativeHandle(ref, () => ({
    clearDraft: () => {
      setText('');
      setAttachments([]);
      releaseAllPreviewUrls();
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      setMenuOpen(false);
      setPreviewUrl(null);
      setTranslateMode(false);
      setTranscribing(false);
      setSubmitting(false);
      try { mediaRecorder.current?.stop(); } catch { /* ignore */ }
      streamRef.current?.getTracks().forEach(t => t.stop());
      mediaRecorder.current = null;
      streamRef.current = null;
      setCameraOpen(false);
      setImageGenerationMode(false);
      setRecording(false);
      textareaRef.current?.focus();
    },
    setDraft: (text) => {
      setText(typeof text === 'string' ? text : '');
      setTranslateMode(false);
      setPreviewUrl(null);
      textareaRef.current?.focus();
    },
  }));
  const menuRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const docInputRef = useRef(null);
  const mediaRecorder = useRef(null);
  const audioChunks = useRef([]);
  const streamRef = useRef(null);
  const autoSendRef = useRef(false);
  const previewUrlsRef = useRef([]);

  const releasePreviewUrl = (url) => {
    if (!url || !url.startsWith('blob:')) return;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  };

  const releaseAllPreviewUrls = () => {
    previewUrlsRef.current.forEach(releasePreviewUrl);
    previewUrlsRef.current = [];
  };

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(DRAFT_KEY);
      if (saved) setText(saved);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      try { sessionStorage.setItem(DRAFT_KEY, text); } catch { /* ignore */ }
    }, 200);
    return () => clearTimeout(id);
  }, [text]);

  useEffect(() => {
    const onOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onEscape = (e) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setPreviewUrl(null);
        setCameraOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, []);

  const hasContent = text.trim().length > 0 || attachments.length > 0;
  const busyAttachments = attachments.some(a => a.status === 'compressing');

  const handleSend = async () => {
    if (loading || transcribing || submitting || busyAttachments) return;
    const trimmed = text.trim();

    // Image generation mode reuses the SAME composer + Send button. The typed
    // prompt goes straight to the image generator; on success the input is
    // cleared and mode is exited (matching the existing UX), on failure the
    // prompt is kept so the user can retry.
    if (imageGenerationMode) {
      if (!trimmed) return;
      setSubmitting(true);
      if (typeof onGenerateImage === 'function') {
        const result = await onGenerateImage(trimmed);
        if (result && result.ok) {
          setText('');
          setAttachments([]);
          releaseAllPreviewUrls();
          setMenuOpen(false);
          setImageGenerationMode(false);
        }
      }
      setSubmitting(false);
      textareaRef.current?.focus();
      return;
    }

    if (!trimmed && attachments.length === 0) return;
    let content = trimmed;
    if (translateMode && trimmed) {
      const src = sourceLanguage ? translateTargets.find(l => l.code === sourceLanguage)?.name : '';
      const target = translateTargets.find(l => l.code === targetLanguage)?.name || 'Spanish';
      content = src ? `Translate from ${src} to ${target}:\n\n${trimmed}` : `Translate to ${target}:\n\n${trimmed}`;
    }
    const payload = { content, attachments, mode: codingMode ? 'coding' : undefined };
    setSubmitting(true);
    setAttachments(prev => prev.map(a => (a.status ? { ...a, status: 'uploading' } : a)));
    const result = await onSend(payload);
    setSubmitting(false);
    if (result && result.success) {
      setText('');
      setAttachments([]);
      releaseAllPreviewUrls();
      setMenuOpen(false);
    } else if (result && Array.isArray(result.failures) && result.failures.length > 0) {
      setAttachments(prev => prev.map((a, i) => (result.failures.includes(i) ? { ...a, status: 'error' } : a)));
    }
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const addAttachment = (file, kind) => {
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let preview;
    if (isImage) {
      try {
        preview = URL.createObjectURL(file);
        previewUrlsRef.current.push(preview);
      } catch { /* fallback: no preview */ }
    }
    setAttachments(prev => [
      ...prev,
      {
        _id: id,
        file,
        name: file.name,
        type: file.type,
        status: 'ready',
        preview,
        progress: 100,
      },
    ]);
    if (isImage) compressAttachment(id, file);
  };

  const compressAttachment = async (id, file) => {
    setAttachments(prev => prev.map(a => (a._id === id ? { ...a, status: 'compressing', progress: 5 } : a)));
    let result = null;
    try {
      result = await compressImage(file, {
        onProgress: (p) => setAttachments(prev => prev.map(a => (a._id === id ? { ...a, progress: p } : a))),
      });
    } catch { /* keep original file on failure */ }

    if (result && result.changed) {
      let preview;
      try {
        preview = URL.createObjectURL(result.file);
        previewUrlsRef.current.push(preview);
      } catch { /* keep original preview */ }
      let originalPreview = null;
      setAttachments(prev => {
        const target = prev.find(a => a._id === id);
        originalPreview = target?.preview;
        return prev.map(a => (
          a._id === id
            ? { ...a, file: result.file, type: result.file.type || a.type, name: result.file.name, preview: preview || a.preview }
            : a
        ));
      });
      if (originalPreview && originalPreview !== preview) {
        setTimeout(() => releasePreviewUrl(originalPreview), 300);
      }
    }

    setAttachments(prev => prev.map(a => (a._id === id ? { ...a, status: 'ready', progress: 100 } : a)));
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = Array.from(items)
      .filter(it => it.kind === 'file' && SUPPORTED_PASTE_IMAGE_TYPES.includes(it.type))
      .map(it => it.getAsFile())
      .filter(Boolean);
    if (imageFiles.length === 0) return;
    e.preventDefault();
    addAttachmentList(imageFiles, 'image');
    textareaRef.current?.focus();
  };

  const addAttachmentList = (files, kind) => {
    for (const f of files) addAttachment(f, kind);
  };

  const handleFileChange = (e) => {
    const fs = e.target.files ? Array.from(e.target.files) : [];
    addAttachmentList(fs, 'file');
    e.target.value = '';
  };

  const handleImageChange = (e) => {
    const fs = e.target.files ? Array.from(e.target.files) : [];
    addAttachmentList(fs, 'image');
    e.target.value = '';
  };

  const removeAttachment = (idx) => {
    setAttachments(prev => {
      const target = prev[idx];
      if (target && target.preview) releasePreviewUrl(target.preview);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const retryAttachment = (idx) => {
    setAttachments(prev => prev.map((a, i) => (i === idx ? { ...a, status: 'ready' } : a)));
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    addAttachmentList(files.filter(f => f.type.startsWith('image/')), 'image');
    addAttachmentList(files.filter(f => !f.type.startsWith('image/')), 'file');
  };

  const teardownRecorder = () => {
    mediaRecorder.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
  };

  const openCamera = () => {
    setMenuOpen(false);
    setCameraOpen(true);
  };

  const finishRecording = (autoSend) => {
    autoSendRef.current = autoSend;
    teardownRecorder();
    setRecording(false);
  };

  const beginRecording = () => {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        mediaRecorder.current = new MediaRecorder(stream);
        audioChunks.current = [];
        mediaRecorder.current.ondataavailable = (e) => audioChunks.current.push(e.data);
        mediaRecorder.current.onstop = () => {
          const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
          const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
          handleVoiceResult(file);
        };
        mediaRecorder.current.start();
        setRecording(true);
      } catch {
        setRecording(false);
        setVoiceMode(false);
      }
    })();
  };

  const handleVoiceResult = async (file) => {
    const sendDirectly = autoSendRef.current;
    autoSendRef.current = false;
    setVoiceMode(false);

    if (sendDirectly) {
      onSend({ content: '', attachments: [{ file, name: 'Voice recording', type: 'audio/webm', isVoice: true }] });
      return;
    }

    setTranscribing(true);
    try {
      const res = await api.transcribeAudio(file);
      if (res.success && res.data?.text) {
        setText(prev => (prev.trim() + (prev.trim() ? ' ' : '') + res.data.text).trim());
      } else {
        setAttachments(prev => [...prev, { file, name: 'Voice recording', type: 'audio/webm', isVoice: true }]);
      }
    } catch {
      setAttachments(prev => [...prev, { file, name: 'Voice recording', type: 'audio/webm', isVoice: true }]);
    }
    setTranscribing(false);
    textareaRef.current?.focus();
  };

  const toggleMic = () => {
    if (loading || transcribing || submitting) return;
    if (recording) {
      finishRecording(false);
      return;
    }
    setVoiceMode(false);
    beginRecording();
  };

  const toggleVoiceMode = () => {
    if (loading || transcribing || submitting) return;
    if (recording) {
      finishRecording(true);
      return;
    }
    setVoiceMode(true);
    setText('');
    beginRecording();
  };

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    releaseAllPreviewUrls();
  }, []);

  const inputPlaceholder = recording
    ? 'Listening...'
    : loading
      ? 'Generating...'
      : codingMode
        ? 'Ask for code, debugging, or explanation...'
        : translateMode
          ? `Type text to translate to ${translateTargets.find(l => l.code === targetLanguage)?.name || 'Spanish'}...`
          : imageGenerationMode
            ? 'Describe the image you want to create...'
            : attachments.length > 0
            ? 'Ask about this...'
            : (placeholder || 'Ask AURA anything...');

  return (
    <div className={`input-area ${dragActive ? 'drag-active' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}>
      <div className="composer-wrap">
        {translateMode && (
          <div className="composer-translate">
            <div className="translate-meta">
              <Languages size={14} />
            </div>
            <select
              className="language-select"
              value={sourceLanguage}
              onChange={e => setSourceLanguage(e.target.value)}
              aria-label="Source translation language"
              title="Source language"
            >
              <option value="">Auto Detect</option>
              {translateTargets.map(l => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </select>
            <ArrowLeftRight size={13} className="translate-arrow" />
            <select
              className="language-select"
              value={targetLanguage}
              onChange={e => setTargetLanguage(e.target.value)}
              aria-label="Target translation language"
              title="Target language"
            >
              {translateTargets.map(l => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </select>
            <button
              className="remove-btn"
              onClick={() => setTranslateMode(false)}
              aria-label="Close translation mode"
              title="Close translation"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {imageGenerationMode && (
          <div className="composer-mode">
            <Wand2 size={13} />
            Image generation
            <button className="remove-btn" onClick={() => setImageGenerationMode(false)} aria-label="Disable image generation" title="Disable image generation">
              <X size={12} />
            </button>
          </div>
        )}

        {codingMode && (
          <div className="composer-mode">
            <Braces size={13} />
            Coding mode
            <button className="remove-btn" onClick={() => setCodingMode(false)} aria-label="Disable coding mode" title="Disable coding mode">
              <X size={12} />
            </button>
          </div>
        )}

        <div className={`aura-composer ${recording ? 'recording' : ''} ${voiceMode ? 'voice' : ''}`}>
          {attachments.length > 0 && (
            <div className="composer-attachments" aria-label="Attached files">
              {attachments.map((att, i) => (
                att.preview ? (
                  <div key={i} className={`composer-att ${att.status === 'error' ? 'error' : ''}`}>
                    <div className="composer-att-thumb">
                      <SmartImage
                        src={att.preview}
                        alt=""
                        mini
                        containerClassName="smart-image-fill"
                        skeletonStyle={{ borderRadius: 12 }}
                        onClick={() => setPreviewUrl(att.preview)}
                      />
                      {(att.status === 'uploading' || att.status === 'compressing') && (
                        <span
                          className="composer-att-badge loading"
                          aria-label={att.status === 'compressing' ? 'Optimizing image' : 'Uploading'}
                          title={att.status === 'compressing' ? 'Optimizing image...' : 'Uploading'}
                        >
                          <span className="att-spinner" />
                        </span>
                      )}
                      {att.status === 'compressing' && (
                        <div className="composer-att-progress">
                          <div className="composer-att-progress-fill" style={{ width: `${att.progress || 0}%` }} />
                        </div>
                      )}
                      {att.status === 'uploading' && (
                        <div className="composer-att-progress uploading" />
                      )}
                      {att.status === 'error' && (
                        <span className="composer-att-badge error" aria-label="Upload failed" title="Upload failed">
                          <AlertTriangle size={11} />
                        </span>
                      )}
                      <button className="remove-btn" onClick={() => removeAttachment(i)} disabled={submitting} aria-label="Remove image" title="Remove image">
                        <X size={11} />
                      </button>
                    </div>
                    {att.status === 'compressing' && (
                      <div className="composer-att-status">Optimizing image {att.progress || 0}%</div>
                    )}
                    {att.status === 'uploading' && (
                      <div className="composer-att-status">Uploading...</div>
                    )}
                    {att.status === 'error' && (
                      <div className="composer-att-fail">
                        <span>Upload failed</span>
                        <button onClick={() => retryAttachment(i)}>Retry</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={i} className={`composer-att doc ${att.status === 'error' ? 'error' : ''}`}>
                    <FileText size={14} />
                    {att.status === 'uploading' && <span className="att-spinner" />}
                    <button className="remove-btn" onClick={() => removeAttachment(i)} disabled={submitting} aria-label="Remove file" title="Remove file">
                      <X size={12} />
                    </button>
                    {att.status === 'error' && (
                      <button className="composer-att-retry" onClick={() => retryAttachment(i)} title="Retry upload">Retry</button>
                    )}
                  </div>
                )
              ))}
            </div>
          )}

          <div className="composer-input-row">
            <div className="composer-tools" ref={menuRef}>
            <button
              className={`composer-plus ${menuOpen ? 'open' : ''}`}
              onClick={() => setMenuOpen(o => !o)}
              aria-label="Add to message"
              title="Add files or tools"
              aria-expanded={menuOpen}
            >
              <Plus size={20} />
            </button>

            {menuOpen && (
              <div className="composer-toolmenu" role="menu" aria-label="Attachment tools">
                <button role="menuitem" onClick={openCamera}>
                  <Camera size={16} /> Camera
                </button>
                <button role="menuitem" onClick={() => { imageInputRef.current?.click(); setMenuOpen(false); }}>
                  <ImageIcon size={16} /> Add image
                </button>
                <button role="menuitem" onClick={() => { fileInputRef.current?.click(); setMenuOpen(false); }}>
                  <FileUp size={16} /> Upload file
                </button>
                <button role="menuitem" onClick={() => { docInputRef.current?.click(); setMenuOpen(false); }}>
                  <FileText size={16} /> Document
                </button>
                <button role="menuitem" onClick={() => { setTranslateMode(o => !o); setMenuOpen(false); }}>
                  <Languages size={16} /> {translateMode ? 'Close translation' : 'Translate'}
                </button>
                <button role="menuitem" onClick={() => { setImageGenerationMode(o => !o); setMenuOpen(false); }}>
                  <Wand2 size={16} /> {imageGenerationMode ? 'Exit image generation' : 'Create image'}
                </button>
                <button role="menuitem" onClick={() => { setCodingMode(o => !o); setMenuOpen(false); }}>
                  <Braces size={16} /> {codingMode ? 'Exit coding mode' : 'Coding mode'}
                </button>
              </div>
            )}
          </div>

          <TextareaAutosize
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder}
            minRows={1}
            maxRows={8}
            className="composer-textarea"
            aria-label="Message AURA"
            disabled={recording}
          />

          <div className="composer-controls">
            {!loading && !recording && !hasContent && (
              <button
                className="composer-round subtle"
                onClick={toggleMic}
                aria-label="Voice input"
                title="Record voice message"
              >
                {transcribing ? <span className="mini-spinner" /> : <Mic size={18} />}
              </button>
            )}

            {recording ? (
              <button
                className="composer-round stop"
                onClick={() => {
                  if (voiceMode) finishRecording(true);
                  else finishRecording(false);
                }}
                aria-label="Stop recording"
                title={voiceMode ? 'Stop and send' : 'Stop and transcribe'}
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : loading ? (
              <button
                className="composer-round subtle"
                onClick={() => onStop?.()}
                aria-label="Stop generating"
                title="Stop generating"
              >
                <Square size={16} />
              </button>
            ) : hasContent ? (
              <button
                className="composer-round send"
                onClick={handleSend}
                disabled={!hasContent || loading || submitting || busyAttachments}
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp size={20} />
              </button>
            ) : (
              <button
                className={`composer-round voice ${voiceMode ? 'active' : ''}`}
                onClick={toggleVoiceMode}
                aria-label="Voice mode"
                title="Voice conversation"
                aria-pressed={voiceMode}
              >
                <AudioLines size={20} />
              </button>
            )}
          </div>
          </div>
        </div>

        <div className="composer-hint">
          {recording
            ? 'Recording... tap stop to finish'
            : transcribing
              ? 'Transcribing...'
              : loading
                ? 'Generating response...'
                : busyAttachments
                  ? 'Optimizing images before sending...'
                  : 'Enter to send · Shift+Enter for new line'}
        </div>
      </div>

      <input ref={fileInputRef} type="file" hidden onChange={handleFileChange}
        accept=".pdf,.docx,.txt,.md,.csv,.json,.js,.ts,.py,.java,.c,.cpp,.html,.css,.sql" />
      <input ref={imageInputRef} type="file" hidden onChange={handleImageChange} accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple />
      <input ref={docInputRef} type="file" hidden onChange={handleFileChange}
        accept=".pdf,.docx,.txt,.md,.csv,.json" />

      <Suspense fallback={null}>
        <ImagePreviewOverlay url={previewUrl} onClose={() => setPreviewUrl(null)} />
      </Suspense>

      <Suspense fallback={null}>
        <CameraOverlay
          open={cameraOpen}
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => addAttachment(file, 'image')}
        />
      </Suspense>
    </div>
  );
});

export default ChatInput;