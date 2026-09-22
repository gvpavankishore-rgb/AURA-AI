import { supabase } from '../lib/supabase';

// API base URL.
//
// - Production (Render static site): set VITE_API_URL to the deployed backend
//   origin (e.g. https://aura-ai-backend-tpe2.onrender.com). Because VITE_*
//   variables are baked in at BUILD time, the already-deployed bundle does NOT
//   pick this up until the frontend is rebuilt and redeployed.
// - Local development: set VITE_API_URL=http://localhost:5001, OR leave it
//   blank to fall back to the relative '/api' used by the Vite dev proxy
//   (frontend/vite.config.js proxies /api -> localhost:5001). Production must
//   never rely on that proxy, so the fallback '/api' must NOT be used when the
//   backend is deployed on a separate origin.
//
// The variable holds the backend ORIGIN (no trailing slash, no '/api' segment).
// '/api' is appended here. If someone instead configures VITE_API_URL to end
// with '/api', it is kept as-is so we never produce a doubled
// "…/api/api/…" or reversed "…//api" path.
const rawApiUrl = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
const BASE = rawApiUrl.endsWith('/api')
  ? rawApiUrl
  : (rawApiUrl ? `${rawApiUrl}/api` : '/api');
const ORIGIN = rawApiUrl ? rawApiUrl.replace(/\/api$/, '') : '';

// Resolve a backend-served upload path. `path` is the stored filename (e.g.
// "uuid.png" or "subdir/uuid.png"). In production the backend is a different
// origin, so the URL must be absolutized here; locally it stays relative and
// the Vite dev proxy (/uploads -> localhost:5001) handles it.
export const uploadUrl = (path) => {
  if (!path) return '';
  const filename = String(path).split(/[\\/]/).pop();
  return ORIGIN ? `${ORIGIN}/uploads/${filename}` : `/uploads/${filename}`;
};

const FALLBACK_ERROR = 'Something went wrong. Please try again.';
export const NETWORK_ERROR_MESSAGE = 'Network error. Please check your connection and try again.';
export const TIMEOUT_MESSAGE = 'The request timed out. Please try again.';

// Cooldown between automatic token refreshes. Prevents a 401 - refresh -
// 401 - refresh ... loop (each refresh hits Supabase's /token endpoint, and
// too many Auth requests in a short window trip GoTrue rate limits, which
// surface as "Too many attempts" on signup/login).
const AUTO_REFRESH_COOLDOWN_MS = 30000;

// Request reliability tuning.
const REQUEST_TIMEOUT_MS = 60000;
const STREAM_CONNECT_TIMEOUT_MS = 45000;  // waiting for the first response bytes
const STREAM_STALL_TIMEOUT_MS = 60000;    // no data received for this long
const RETRY_ATTEMPTS = 2;                 // extra tries after the first attempt
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 3000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const isRetryableStatus = (status) => RETRYABLE_STATUS.has(status);

const messageForStatus = (status) => {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 404) return 'The requested resource was not found.';
  if (status === 429) return 'Too many requests. Please try again in a moment.';
  if (status >= 500) return 'The server could not process the request. Please try again.';
  return FALLBACK_ERROR;
};

class ApiService {
  constructor() {
    this.token = null;
    this.lastAutoRefreshAt = 0;
  }

  setAccessToken(token) {
    this.token = token || null;
  }

  async request(endpoint, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      raw = false,
      timeout = REQUEST_TIMEOUT_MS,
      retries = RETRY_ATTEMPTS,
      signal = null,
    } = options;

    if (signal && signal.aborted) {
      return { success: false, message: 'Request cancelled.' };
    }

    const buildConfig = (controller) => {
      const configHeaders = { ...headers };
      if (this.token) configHeaders['Authorization'] = `Bearer ${this.token}`;
      if (body && !(body instanceof FormData)) configHeaders['Content-Type'] = 'application/json';
      const config = { method, headers: configHeaders, signal: controller.signal };
      if (body && !(body instanceof FormData)) config.body = JSON.stringify(body);
      else if (body instanceof FormData) config.body = body;
      return config;
    };

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        let res = await fetch(`${BASE}${endpoint}`, buildConfig(controller));

        if (res.status === 401 && this.token) {
          const now = Date.now();
          if (now - this.lastAutoRefreshAt >= AUTO_REFRESH_COOLDOWN_MS) {
            this.lastAutoRefreshAt = now;
            const { data, error } = await supabase.auth.refreshSession();
            if (!error && data.session) {
              this.token = data.session.access_token;
              res = await fetch(`${BASE}${endpoint}`, buildConfig(controller));
            }
          }
          if (res.status === 401 && this.token) this.token = null;
        }

        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);

        if (!res.ok) {
          if (isRetryableStatus(res.status) && attempt < retries) {
            attempt += 1;
            await delay(Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS));
            continue;
          }
          if (raw) return res;
          try {
            const parsed = await res.json();
            return parsed && typeof parsed === 'object' ? parsed : { success: false, message: messageForStatus(res.status) };
          } catch {
            return { success: false, message: messageForStatus(res.status) };
          }
        }

        if (raw) return res;
        try {
          return await res.json();
        } catch {
          return { success: false, message: FALLBACK_ERROR };
        }
      } catch {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        if (signal && signal.aborted) {
          return { success: false, message: 'Request cancelled.' };
        }
        if (attempt < retries) {
          attempt += 1;
          await delay(Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS));
          continue;
        }
        return { success: false, message: timedOut ? TIMEOUT_MESSAGE : NETWORK_ERROR_MESSAGE };
      }
    }
  }

  async getProfile() { return this.request('/users/me'); }
  async updateMe(data) { return this.request('/users/me', { method: 'PATCH', body: data, retries: 0 }); }
  async deleteAccount() { return this.request('/users/me', { method: 'DELETE', retries: 0 }); }

  async getChats(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/chats${query ? '?' + query : ''}`);
  }
  async createChat(data) { return this.request('/chats', { method: 'POST', body: data, retries: 0 }); }
  async getChat(id) { return this.request(`/chats/${id}`); }
  async updateChat(id, data) { return this.request(`/chats/${id}`, { method: 'PATCH', body: data, retries: 0 }); }
  async deleteChat(id) { return this.request(`/chats/${id}`, { method: 'DELETE', retries: 0 }); }
  async deleteAllChats() { return this.request('/chats/all', { method: 'DELETE', retries: 0 }); }

  async sendMessage(data) { return this.request('/chat/message', { method: 'POST', body: data, retries: 0 }); }

  async streamMessage(payload, {
    onMeta, onDeveloper, onAction, onSources, onChunk, onDone, onError, onAbort, signal,
  } = {}) {
    // Internal watchdog keeps the call from hanging forever without
    // interfering with the caller's own abort (Stop generation) signal.
    const watchdog = new AbortController();
    let stalledTimedOut = false;
    let stallTimer = null;

    const onExternalAbort = () => watchdog.abort();
    if (signal && signal.aborted) { onAbort?.(); return; }
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    const clearStall = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };
    const armStall = (ms) => {
      clearStall();
      stallTimer = setTimeout(() => {
        stalledTimedOut = true;
        watchdog.abort();
      }, ms);
    };
    const cleanup = () => {
      clearStall();
      signal?.removeEventListener('abort', onExternalAbort);
    };
    const isCallerAborted = () => (signal ? signal.aborted : false);
    const finish = (handler, ...args) => {
      cleanup();
      handler?.(...args);
    };

    const doFetch = (token) => fetch(`${BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: watchdog.signal,
    });

    let res;
    armStall(STREAM_CONNECT_TIMEOUT_MS);
    try {
      res = await doFetch(this.token);
    } catch (err) {
      clearStall();
      if (isCallerAborted()) return finish(onAbort);
      if (stalledTimedOut) return finish(onError, TIMEOUT_MESSAGE);
      return finish(onError, NETWORK_ERROR_MESSAGE);
    }

    if (res.status === 401 && this.token) {
      const { data, error } = await supabase.auth.refreshSession();
      if (!error && data?.session) {
        this.token = data.session.access_token;
        try {
          res = await doFetch(this.token);
        } catch (err) {
          clearStall();
          if (isCallerAborted()) return finish(onAbort);
          if (stalledTimedOut) return finish(onError, TIMEOUT_MESSAGE);
          return finish(onError, NETWORK_ERROR_MESSAGE);
        }
      }
    }

    if (!res.ok) {
      clearStall();
      let message = 'Request failed';
      try {
        const parsed = await res.json();
        if (parsed && typeof parsed.message === 'string' && parsed.message) message = parsed.message;
      } catch {}
      if (res.status === 401) {
        message = 'Your session has expired. Please sign in again.';
      } else if (res.status === 429) {
        message = 'Too many requests. Please try again in a moment.';
      } else if (res.status >= 500) {
        message = 'The server could not process the request. Please try again.';
      }
      return finish(onError, message);
    }

    armStall(STREAM_STALL_TIMEOUT_MS);
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const raw = line.slice(6);
            if (raw === '[DONE]') return finish(onDone);
            try {
              const parsed = JSON.parse(raw);
              if (parsed.error) return finish(onError, parsed.error);
              if (parsed.type === 'developer_profile') { onDeveloper?.(parsed); }
              else if (parsed.type === 'action_confirmation') { onAction?.(parsed); }
              else if (parsed.type === 'sources') { onSources?.(Array.isArray(parsed.sources) ? parsed.sources : []); }
              else if (parsed.chatId) { onMeta?.(parsed); }
              else if (parsed.content) { onChunk?.(parsed.content); }
            } catch {}
          }
        }
        // Reset the stall timer whenever the server actually sends data.
        if (!stallTimer) armStall(STREAM_STALL_TIMEOUT_MS);
        else { clearStall(); armStall(STREAM_STALL_TIMEOUT_MS); }
        if (isCallerAborted()) return finish(onAbort);
      }
      return finish(onDone);
    } catch (err) {
      clearStall();
      if (isCallerAborted()) return finish(onAbort);
      if (stalledTimedOut) return finish(onError, TIMEOUT_MESSAGE);
      return finish(onError, 'Something went wrong while receiving the response. Please try again.');
    }
  }

  async uploadChatFile(file) {
    const form = new FormData();
    form.append('file', file);
    return this.request('/chat/upload', { method: 'POST', body: form, retries: 0 });
  }

  async uploadDocument(file) {
    const form = new FormData();
    form.append('file', file);
    return this.request('/documents/upload', { method: 'POST', body: form, retries: 0 });
  }
  async getDocuments() { return this.request('/documents'); }
  async getDocument(id) { return this.request(`/documents/${id}`); }
  async deleteDocument(id) { return this.request(`/documents/${id}`, { method: 'DELETE', retries: 0 }); }
  async askDocument(id, question) { return this.request(`/documents/${id}/ask`, { method: 'POST', body: { question }, retries: 0 }); }
  async summarizeDocument(id) { return this.request(`/documents/${id}/summarize`, { method: 'POST', retries: 0 }); }

  async enhanceImage(file, conversationId) {
    const form = new FormData();
    form.append('image', file);
    if (conversationId) form.append('conversationId', conversationId);
    return this.request('/images/enhance', { method: 'POST', body: form, retries: 0, timeout: 120000 });
  }

  async analyzeImage(file, question) {
    const form = new FormData();
    form.append('image', file);
    if (question) form.append('question', question);
    return this.request('/images/analyze', { method: 'POST', body: form, retries: 0, timeout: 120000 });
  }

  async transcribeAudio(file) {
    const form = new FormData();
    form.append('audio', file);
    return this.request('/voice/transcribe', { method: 'POST', body: form, retries: 0, timeout: 120000 });
  }

  async translate(data) { return this.request('/translate', { method: 'POST', body: data, retries: 0 }); }

  async getMemories() { return this.request('/memory'); }
  async addMemory(data) { return this.request('/memory', { method: 'POST', body: data, retries: 0 }); }
  async deleteMemory(id) { return this.request(`/memory/${id}`, { method: 'DELETE', retries: 0 }); }
  async clearMemories() { return this.request('/memory', { method: 'DELETE', retries: 0 }); }

  async getSettings() { return this.request('/settings'); }
  async updateSettings(data) { return this.request('/settings', { method: 'PATCH', body: data, retries: 0 }); }
}

const api = new ApiService();
export default api;