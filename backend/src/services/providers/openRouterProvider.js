import env from '../../config/env.js';

export const USER_ERROR_UNAVAILABLE = 'AI service is temporarily unavailable. Please try again.';
export const AI_KEY_MISSING_MESSAGE = 'AI service is not configured. Set OPENROUTER_API_KEY in backend/.env.';
export const AI_INVALID_RESPONSE_MESSAGE = 'AI service returned an invalid response. Please try again.';
export const AI_AUTH_ERROR_MESSAGE = 'AI service authentication failed. Please verify the OpenRouter API key.';
export const AI_BILLING_MESSAGE = 'OpenRouter credits are unavailable. Please check your OpenRouter account balance.';
export const AI_RATE_LIMIT_MESSAGE = 'AI service is rate limited. Please try again in a moment.';
export const AI_MODEL_UNAVAILABLE_MESSAGE = 'The selected AI model is temporarily unavailable. Please try again.';
export const AI_TIMEOUT_MESSAGE = 'AI service took too long to respond. Please try again.';
export const AI_NETWORK_MESSAGE = 'AI service is unreachable. Please check your connection and try again.';

export const SAFE_ERRORS = new Set([
  USER_ERROR_UNAVAILABLE,
  AI_KEY_MISSING_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AI_AUTH_ERROR_MESSAGE,
  AI_BILLING_MESSAGE,
  AI_RATE_LIMIT_MESSAGE,
  AI_MODEL_UNAVAILABLE_MESSAGE,
  AI_TIMEOUT_MESSAGE,
  AI_NETWORK_MESSAGE,
]);

export const isSafeAiErrorMessage = (message) => SAFE_ERRORS.has(message);

const throwFriendly = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Optional app-identification headers for OpenRouter (keys come from env).
export const buildHeaders = (json = true, key = env.openRouterApiKey) => {
  const headers = {
    Authorization: `Bearer ${key}`,
    'HTTP-Referer': env.openRouterSiteUrl,
    'X-Title': env.openRouterAppName,
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
};

const baseUrl = () => env.openRouterBaseUrl;

// Two-account failover: a request is first attempted with key 1 and, if it
// fails (auth, credits, rate limit, 5xx, network, ...), retried with key 2.
// The failure that ultimately surfaces is the last key's, so no secrets or
// upstream details leak to the client.
const withKeyFailover = async ({ url, init }) => {
  const keys = env.openRouterKeys;
  if (!keys.length) throw throwFriendly(AI_KEY_MISSING_MESSAGE, 503);
  const jsonHeaders = Boolean(init.headers && init.headers['Content-Type']);

  let lastErr = null;
  for (let i = 0; i < keys.length; i += 1) {
    let res;
    try {
      res = await fetch(url, { ...init, headers: buildHeaders(jsonHeaders, keys[i]) });
    } catch (err) {
      lastErr = err;
      if (i < keys.length - 1) {
        console.error(`[OpenRouter] ${url} attempt ${i + 1}/${keys.length} network error: ${err?.cause?.message || err?.message || err} — failing over to backup key.`);
      }
      continue;
    }

    if (res.ok) return res;

    const raw = await res.text().catch(() => '');
    lastErr = mapHttpError({ urlPath: url, res, raw });
    if (i < keys.length - 1) {
      console.error(`[OpenRouter] ${url} HTTP ${res.status} with key ${i + 1}/${keys.length} — failing over to backup key.`);
    }
  }
  throw lastErr;
};

// Map an OpenRouter error response (or an embedded error object) to a
// user-friendly message. The full upstream details are logged server-side.
export const mapHttpError = ({ urlPath, res, raw }) => {
  let message = '';
  let code = 0;
  let errorType = '';
  try {
    const parsed = JSON.parse(raw || '');
    message = parsed?.error?.message || parsed?.message || '';
    code = Number(parsed?.error?.code) || 0;
    errorType = parsed?.error?.metadata?.error_type || '';
  } catch {
    message = String(raw || '').slice(0, 300);
  }

  console.error(`[OpenRouter] ${urlPath} HTTP ${res.status || code}:`, message || raw || '(no error body)');

  const status = code || res.status || 500;
  const combined = `${message} ${errorType} ${status}`.toLowerCase();

  if (status === 504 || status === 408 || /timeout|timed out/i.test(combined)) {
    return throwFriendly(AI_TIMEOUT_MESSAGE, 504);
  }
  if (status === 402 || /credit|balance|billing|payment|quota|insufficient fund/i.test(combined)) {
    return throwFriendly(AI_BILLING_MESSAGE, 502);
  }
  if (status === 401 || status === 403 || /authentication|unauthorized|forbidden|invalid.*key|api key/i.test(combined)) {
    return throwFriendly(AI_AUTH_ERROR_MESSAGE, 502);
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(combined)) {
    return throwFriendly(AI_RATE_LIMIT_MESSAGE, 502);
  }
  if (status === 404 || /no endpoints found|model.*not found|unsupported.*model|does not exist/i.test(combined)) {
    return throwFriendly(AI_MODEL_UNAVAILABLE_MESSAGE, 502);
  }
  if (status === 502 || status === 503 || (status >= 500 && status < 600)) {
    return throwFriendly(AI_MODEL_UNAVAILABLE_MESSAGE, 502);
  }
  return throwFriendly(USER_ERROR_UNAVAILABLE, 502);
};

// Map a mid-stream SSE error chunk (shape { code, message, metadata }).
export const mapStreamError = (errorObj) => mapHttpError({
  urlPath: '/chat/completions',
  res: { status: Number(errorObj?.code) || 502 },
  raw: JSON.stringify({ error: errorObj }),
});

const handleResponse = async ({ urlPath, res }) => {
  if (res.ok) return res;
  const raw = await res.text().catch(() => '');
  throw mapHttpError({ urlPath, res, raw });
};

const postJson = async ({ urlPath, body, timeoutMs = 120000 }) => {
  const url = `${baseUrl()}/${urlPath}`;
  let res;
  try {
    res = await withKeyFailover({
      url,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    });
  } catch (err) {
    // A friendly error surfaced by the failover chain is already mapped for
    // the user; only raw network/abort errors are re-mapped here.
    if (err && err.statusCode) throw err;
    const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || err?.message?.includes('aborted');
    console.error(`[OpenRouter] ${urlPath} network error:`, timedOut ? 'timeout' : (err?.cause?.message || err?.message || err));
    throw throwFriendly(timedOut ? AI_TIMEOUT_MESSAGE : AI_NETWORK_MESSAGE, timedOut ? 504 : 503);
  }
  return handleResponse({ urlPath, res });
};

const postForm = async ({ urlPath, form, timeoutMs = 120000 }) => {
  const url = `${baseUrl()}/${urlPath}`;
  let res;
  try {
    res = await withKeyFailover({
      url,
      init: {
        method: 'POST',
        headers: {},
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      },
    });
  } catch (err) {
    if (err && err.statusCode) throw err;
    const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || err?.message?.includes('aborted');
    console.error(`[OpenRouter] ${urlPath} network error:`, timedOut ? 'timeout' : (err?.cause?.message || err?.message || err));
    throw throwFriendly(timedOut ? AI_TIMEOUT_MESSAGE : AI_NETWORK_MESSAGE, timedOut ? 504 : 503);
  }
  return handleResponse({ urlPath, res });
};

export const chatCompletions = async ({ model, messages, stream, max_tokens = 4096 }) => {
  const res = await postJson({
    urlPath: 'chat/completions',
    body: { model, messages, max_tokens, stream },
  });
  return res;
};

// OpenAI-style multipart transcription upload (matches OpenRouter contract).
export const transcribeAudio = async ({ model, formData }) => {
  const res = await postForm({ urlPath: 'audio/transcriptions', form: formData });
  const raw = await res.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  if (typeof data?.text !== 'string') {
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  return { text: data.text };
};

// OpenAI-compatible text-to-speech. Returns raw MP3 bytes (base64-wrapped).
export const textToSpeech = async ({ model, voice, speed, input }) => {
  const res = await postJson({
    urlPath: 'audio/speech',
    body: { model, voice, speed, input, response_format: 'mp3' },
  });
  const buffer = Buffer.from(await res.arrayBuffer().catch(() => Buffer.from('')));
  return { audio: buffer.toString('base64') };
};