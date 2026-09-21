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
export const buildHeaders = (json = true) => {
  const headers = {
    Authorization: `Bearer ${env.openRouterApiKey}`,
    'HTTP-Referer': env.openRouterSiteUrl,
    'X-Title': env.openRouterAppName,
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
};

const baseUrl = () => env.openRouterBaseUrl;

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
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
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
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(false),
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
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

// OpenRouter image generation uses POST /images (NOT OpenAI's
// /images/generations). Response shape: { data: [{ b64_json, media_type }] }.
export const createImage = async ({ model, prompt, size }) => {
  const body = { model, prompt, n: 1 };
  if (size) body.size = size;
  const res = await postJson({ urlPath: 'images', body });
  const raw = await res.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  const item = data?.data?.[0];
  if (!item || typeof item.b64_json !== 'string') {
    console.error('[OpenRouter] Malformed image response:', raw.slice(0, 500));
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  return {
    image: item.b64_json,
    mediaType: item.media_type || 'image/png',
  };
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