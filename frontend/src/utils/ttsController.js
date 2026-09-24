const CHUNK_MAX_CHARS = 200;
const FIRST_SPEAK_DELAY_MS = 60;
const RESYNC_INTERVAL_MS = 8000;
const MAX_SPEECH_CHARS = 3500;

export const STATE = Object.freeze({
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
});

export const chunkText = (text, max = CHUNK_MAX_CHARS) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks = [];
  let buf = '';
  for (const word of words) {
    if (buf !== '' && buf.length + 1 + word.length > max) {
      chunks.push(buf);
      buf = word;
    } else {
      buf = buf === '' ? word : `${buf} ${word}`;
    }
  }
  if (buf !== '') chunks.push(buf);
  return chunks;
};

export const stripForSpeech = (text) => {
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
    .trim()
    .replace(/\s+([.,;:!?)])/g, '$1');
  if (
    clean.startsWith('{') &&
    clean.includes('}') &&
    (clean.includes('":"') || clean.includes("':'") || clean.includes('":'))
  ) {
    clean = 'The response contains structured data. Please view it in the chat.';
  }
  return clean.slice(0, MAX_SPEECH_CHARS);
};

export const createTtsSpeaker = ({
  speechSynthesis,
  createUtterance = (t) => new SpeechSynthesisUtterance(t),
  pickVoice = null,
  onState = () => {},
  firstSpeakDelayMs = FIRST_SPEAK_DELAY_MS,
  resyncIntervalMs = RESYNC_INTERVAL_MS,
  chunkMaxChars = CHUNK_MAX_CHARS,
}) => {
  if (!speechSynthesis) return null;

  let sessionToken = 0;
  let activeMsgId = null;
  let chunks = [];
  let index = 0;
  let utterance = null;
  let pausedByUser = false;
  let resyncTimer = null;
  let startTimer = null;

  const clearResync = () => {
    if (resyncTimer) {
      clearInterval(resyncTimer);
      resyncTimer = null;
    }
  };

  const startResync = () => {
    clearResync();
    if (!resyncIntervalMs) return;
    resyncTimer = setInterval(() => {
      if (pausedByUser) return;
      try {
        if (speechSynthesis.speaking === true && speechSynthesis.paused === false) {
          speechSynthesis.resume();
        }
      } catch {}
    }, resyncIntervalMs);
  };

  const stop = () => {
    sessionToken += 1;
    activeMsgId = null;
    chunks = [];
    index = 0;
    utterance = null;
    pausedByUser = false;
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    clearResync();
    try {
      speechSynthesis.cancel();
    } catch {}
  };

  const speakChunk = (token, msgId, content) => {
    if (sessionToken !== token || pausedByUser) return;
    const u = createUtterance(content);
    const voice = pickVoice ? pickVoice() : null;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang || 'en-US';
    } else {
      u.lang = 'en-US';
    }
    u.rate = 1;
    u.pitch = 1;
    u.onstart = () => {
      if (sessionToken !== token) return;
      onState(msgId, STATE.PLAYING, false);
    };
    u.onend = () => {
      if (sessionToken !== token) return;
      index += 1;
      if (index >= chunks.length) {
        utterance = null;
        chunks = [];
        index = 0;
        clearResync();
        onState(msgId, STATE.IDLE, false);
      } else {
        speakChunk(token, msgId, chunks[index]);
      }
    };
    u.onerror = (event) => {
      if (sessionToken !== token) return;
      if (event && (event.error === 'canceled' || event.error === 'interrupted' || event.error === 'not-allowed')) {
        return;
      }
      utterance = null;
      chunks = [];
      index = 0;
      clearResync();
      onState(msgId, STATE.IDLE, true);
    };
    utterance = u;
    speechSynthesis.speak(u);
  };

  const start = (msgId, content) => {
    const pieces = chunkText(stripForSpeech(content), chunkMaxChars);
    if (pieces.length === 0) {
      onState(msgId, STATE.IDLE, false);
      return;
    }
    stop();
    const token = sessionToken;
    activeMsgId = msgId;
    chunks = pieces;
    index = 0;
    pausedByUser = false;
    onState(msgId, STATE.PLAYING, false);
    startTimer = setTimeout(() => {
      startTimer = null;
      if (sessionToken !== token) return;
      speakChunk(token, msgId, chunks[0]);
      startResync();
    }, firstSpeakDelayMs);
  };

  const resumePending = (msgId, token) => {
    if (utterance === null && chunks.length > 0 && activeMsgId === msgId) {
      speakChunk(token, msgId, chunks[index]);
      startResync();
    } else {
      startResync();
    }
  };

  const toggle = (msgId, content, currentState) => {
    if (currentState === STATE.PLAYING) {
      pausedByUser = true;
      clearResync();
      try {
        speechSynthesis.pause();
      } catch {}
      onState(msgId, STATE.PAUSED, false);
      return;
    }
    if (currentState === STATE.PAUSED) {
      pausedByUser = false;
      try {
        speechSynthesis.resume();
      } catch {}
      resumePending(msgId, sessionToken);
      onState(msgId, STATE.PLAYING, false);
      return;
    }
    start(msgId, content);
  };

  return {
    toggle,
    start,
    stop,
    destroy: stop,
  };
};