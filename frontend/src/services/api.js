import { supabase } from '../lib/supabase';

// ---------------------------------------------------------------------------
// Centralized backend API base URL.
//
// This is the single source of truth for EVERY backend request the frontend
// makes: /api/chat/stream, /api/chats, /api/users/me, message/regenerate/edit,
// image & document upload, voice, translate, memory, settings, etc. All of
// them go through `BASE` below — never hardcode a backend URL anywhere else.
//
// Resolution order:
//   1. VITE_API_URL (baked into the bundle at BUILD time). On Render set it to
//      the PUBLIC backend origin, e.g.
//      https://aura-ai-backend-tpe2.onrender.com
//   2. Development fallback -> http://localhost:5001 so `npm run dev` keeps
//      talking to the local backend with zero extra configuration.
//   3. Production fallback -> the documented Render backend origin from this
//      project's deployment configuration. A local/loopback URL is NEVER used
//      as a production default.
//
// Extra safety: on production builds, a VITE_API_URL that points at
// localhost/127.0.0.1 is STRIPPED and replaced by the production URL, so the
// deployed bundle can never fail with net::ERR_CONNECTION_REFUSED because
// someone baked http://localhost:5001 into the build.
// ---------------------------------------------------------------------------
const PROD_API_BASE_URL = 'https://aura-ai-backend-tpe2.onrender.com';

const isLocalApiUrl = (url) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(url || '').trim().replace(/\/+$/, ''));

const configuredApiUrl = (() => {
  const value = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (!import.meta.env.DEV && isLocalApiUrl(value)) return '';
  return value;
})();

const apiBaseUrl = configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:5001' : PROD_API_BASE_URL);

// BASE holds the backend ORIGIN plus "/api". If VITE_API_URL is configured to
// already end with "/api" it is kept as-is so we never produce a doubled
// "…/api/api/…" or reversed "…//api" path.
const BASE = apiBaseUrl.endsWith('/api') ? apiBaseUrl : `${apiBaseUrl}/api`;

// ---------------------------------------------------------------------------
// ATTACHMENT URL RESOLUTION
// ---------------------------------------------------------------------------
// Attachments live in a PRIVATE Supabase Storage bucket. The backend mints a
// SHORT-LIVED SIGNED URL for every attachment it returns, and the frontend
// renders that signed URL. Because those URLs expire (by design, see
// SUPABASE_STORAGE_SIGNED_URL_TTL), a tab left open outlives them, so the
// client must be able to swap in a fresh one WITHOUT a full conversation
// refetch. That is what `signAttachmentPaths` below is for.
//
// PRODUCTION NEVER REQUESTS /uploads. A pre-migration row (path `uploads/...`)
// was stored on Render's ephemeral disk and was never copied into the bucket,
// so the file is simply gone: requesting it only produced a 404 in the network
// tab and a broken image. Those attachments resolve to '' and the UI shows an
// "Image unavailable" placeholder, with zero network traffic.
// ---------------------------------------------------------------------------

// Only a Supabase signed-URL is ever treated as renderable. A `preview` blob:
// URL is handled separately (optimistic, never persisted). Anything else — in
// particular a leftover pre-migration `/uploads/...` value — is refused so it
// can never reach an <img src> or a fetch().
const SUPABASE_SIGNED_URL_RE = /\/storage\/v1\/object\/sign\//i;

export const isSignedStorageUrl = (url) => SUPABASE_SIGNED_URL_RE.test(String(url || ''));

// A path that actually lives in the bucket. Everything else is a legacy disk
// row from before the Supabase Storage migration.
export const isStorageKey = (path) => String(path || '').startsWith('user-');

// Pull the `token` claim out of a signed URL and read its `exp`, so the client
// can tell whether a URL it is holding is already dead WITHOUT making a
// request. Returns 0 when the shape is unexpected (be conservative: treat it
// as "unknown" and let the reactive retry path handle it).
export const signedUrlExpiry = (url) => {
  const raw = String(url || '');
  if (!isSignedStorageUrl(raw)) return 0;
  try {
    const token = new URL(raw).searchParams.get('token');
    const segment = token?.split('.')[1];
    if (!segment) return 0;
    // JWT segments are base64url and usually ship UNPADDED; atob() is strict
    // about length, so restore the '=' padding before decoding.
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const exp = Number(JSON.parse(atob(padded))?.exp);
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
};

// Renew a signed URL this many ms before it actually expires, so a
// still-visible image is never swapped out from under the user.
const SIGNED_URL_RENEW_SKEW_MS = 60 * 1000;

export const isSignedUrlStale = (url) => {
  const exp = signedUrlExpiry(url);
  if (!exp) return false; // unknown lifetime -> do not churn requests
  return exp - Date.now() <= SIGNED_URL_RENEW_SKEW_MS;
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// Warn once per distinct reason+path so a long chat with many legacy rows does
// not flood the console on every render.
const warnedLegacy = new Set();
const warnOnce = (key, message) => {
  if (warnedLegacy.has(key)) return;
  warnedLegacy.add(key);
  console.warn(message);
};

// Resolve the display URL for a message attachment.
//
// Precedence:
//   1. att.preview -> local blob: paints the optimistic bubble instantly,
//      before the server has replied. Never persisted.
//   2. att.url     -> signed Supabase Storage URL, valid for BOTH migrated and
//      legacy rows (a legacy row simply has none).
//
// Returns '' when nothing renderable exists — the caller shows the graceful
// "unavailable" placeholder and makes NO network request.
export const attachmentUrl = (att) => {
  if (!att) return '';
  if (att.preview) return att.preview;
  if (isSignedStorageUrl(att.url)) return att.url;

  const path = String(att.path || '');
  if (!path) return '';

  if (isStorageKey(path)) {
    warnOnce(
      `unsigned:${path}`,
      `[attachments] migrated attachment "${path}" arrived without a signed URL. ` +
      'The backend could not sign it — check the chat-attachments bucket and owner policies ' +
      'in backend/src/db/storage_setup.sql. It will be re-requested automatically.'
    );
    return '';
  }

  warnOnce(
    `legacy:${path}`,
    `[attachments] legacy attachment "${path}" predates the Supabase Storage migration. ` +
    'It lived on the backend\'s ephemeral disk and is gone, so no request is made for it ' +
    '(production never requests /uploads) and the UI shows an "unavailable" placeholder. ' +
    'Re-upload the file to restore it.'
  );
  return '';
};

// True when an attachment should be rendered as a chat image rather than a
// document chip. Type is authoritative; the extension checks cover rows
// persisted before `type` was always set.
export const isImageAttachment = (att) =>
  !!att &&
  (att.type === 'image' ||
    /^image\//.test(att.type || '') ||
    (att.mimetype && /^image\//.test(att.mimetype)) ||
    IMAGE_EXT_RE.test(att.path || '') ||
    IMAGE_EXT_RE.test(att.filename || '') ||
    IMAGE_EXT_RE.test(att.name || ''));

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

  // Always pull the CURRENT Supabase session before a request instead of
  // trusting a possibly-stale cached token. Returns the access token or null
  // when there is no (recoverable) session.
  async resolveToken() {
    let session = null;
    try {
      const { data } = await supabase.auth.getSession();
      session = data?.session || null;
    } catch {
      session = null;
    }

    console.log(`[AuthDebug] session exists: ${Boolean(session)}, token length: ${session?.access_token?.length || 0}`);

    if (session && typeof session.expires_at === 'number') {
      const skewMs = 30000; // refresh ~30s before the JWT actually expires
      if (session.expires_at * 1000 - skewMs <= Date.now()) {
        console.log('[AuthDebug] token expired or near expiry - refreshing session');
        try {
          const { data: refreshed } = await supabase.auth.refreshSession();
          session = refreshed?.session || null;
        } catch {
          session = null;
        }
      }
    }

    this.token = session?.access_token || null;
    return this.token;
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

    const token = await this.resolveToken();
    if (!token) {
      return { success: false, status: 401, message: 'Your session has expired. Please sign in again.' };
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

  // Mint fresh signed URLs for a specific set of attachments in a conversation.
  // This is the targeted, cheap alternative to refetching the whole chat: the
  // backend only signs keys that are actually referenced by that conversation's
  // messages, and rejects legacy `uploads/...` rows outright.
  //
  // Returns { urls: { [path]: signedUrl } }. Missing keys simply mean "not
  // signable" (legacy row, or an object the caller cannot read).
  async signAttachmentPaths(chatId, paths) {
    const list = (Array.isArray(paths) ? paths : [paths])
      .map((p) => String(p || '').trim())
      .filter((p) => p && isStorageKey(p));
    if (!chatId || list.length === 0) return { success: true, data: { urls: {} } };
    return this.request(`/chats/${chatId}/attachments/sign`, {
      method: 'POST',
      body: { paths: [...new Set(list)] },
      retries: 0,
    });
  }

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

    let accessToken = null;
    try {
      accessToken = await this.resolveToken();
    } catch {}
    if (!accessToken) return finish(onError, 'Your session has expired. Please sign in again.');

    let res;
    armStall(STREAM_CONNECT_TIMEOUT_MS);
    try {
      res = await doFetch(accessToken);
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