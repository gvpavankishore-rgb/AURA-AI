import env from '../../config/env.js';

export const USER_ERROR_UNAVAILABLE = 'AI service is temporarily unavailable. Please try again.';
export const AI_KEY_MISSING_MESSAGE = 'AI image service is not configured. Set OPENAI_API_KEY in backend/.env.';
export const AI_AUDIO_KEY_MISSING_MESSAGE = 'Voice features are not configured. Set OPENAI_API_KEY in backend/.env.';
export const AI_INVALID_RESPONSE_MESSAGE = 'AI service returned an invalid response. Please try again.';
export const AI_AUTH_ERROR_MESSAGE = 'AI service authentication failed. Please verify the OpenAI API key.';
export const AI_BILLING_MESSAGE = 'AI service is unavailable: OpenAI credits or billing limits reached. Please add credits or check your account.';
export const AI_RATE_LIMIT_MESSAGE = 'AI service is rate limited. Please try again in a moment.';
export const AI_MODEL_UNAVAILABLE_MESSAGE = 'The AI model is temporarily unavailable or does not exist. Please try again.';
export const AI_TIMEOUT_MESSAGE = 'AI service took too long to respond. Please try again.';
export const AI_NETWORK_MESSAGE = 'AI service is unreachable. Please check your connection and try again.';

export const SAFE_ERRORS = new Set([
  USER_ERROR_UNAVAILABLE,
  AI_KEY_MISSING_MESSAGE,
  AI_AUDIO_KEY_MISSING_MESSAGE,
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

const OPENAI_TRANSCRIPTIONS_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const REQUEST_TIMEOUT_MS = 120000;

// Map an OpenAI raw HTTP error into a friendly, shareable message. The full
// upstream body is logged server-side (without the API key).
const classifyHttpError = (status, raw) => {
  console.error(`[OpenAI] HTTP ${status}:`, raw.slice(0, 600) || '(no error body)');
  const combined = `${raw} ${status}`.toLowerCase();
  if (status === 401 || status === 403 || /authentication|unauthorized|invalid.*api key/i.test(combined)) {
    return throwFriendly(AI_AUTH_ERROR_MESSAGE, 502);
  }
  // Insufficient quota / exhausted credits must be checked BEFORE the generic
  // rate-limit rule below (OpenAI returns 429 with an "insufficient_quota"
  // / "no credits" body, and 402 for some endpoints).
  if (status === 402 || status === 409 || /billing|payment|credit|insufficient.?quota|no credits/i.test(combined)) {
    return throwFriendly(AI_BILLING_MESSAGE, 502);
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(combined)) {
    return throwFriendly(AI_RATE_LIMIT_MESSAGE, 502);
  }
  if ((status === 404 || status === 400) && /model.*not found|does not exist|no such model/i.test(combined)) {
    return throwFriendly(AI_MODEL_UNAVAILABLE_MESSAGE, 502);
  }
  if (status >= 500) {
    return throwFriendly(AI_MODEL_UNAVAILABLE_MESSAGE, 502);
  }
  return throwFriendly(USER_ERROR_UNAVAILABLE, 502);
};

const handleFetchError = (err) => {
  const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || err?.message?.includes('aborted');
  console.error('[OpenAI] network error:', timedOut ? 'timeout' : (err?.cause?.message || err?.message || err));
  throw throwFriendly(timedOut ? AI_TIMEOUT_MESSAGE : AI_NETWORK_MESSAGE, timedOut ? 504 : 503);
};

// OpenAI Whisper (speech-to-text). Uploads multipart audio the same way the
// OpenAI SDK does. Returns { text }.
export const transcribeAudio = async ({ model, formData }) => {
  const key = env.openAiApiKey;
  if (!key) throw throwFriendly(AI_AUDIO_KEY_MISSING_MESSAGE, 503);

  let res;
  try {
    res = await fetch(OPENAI_TRANSCRIPTIONS_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: formData,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    handleFetchError(err);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) throw classifyHttpError(res.status, raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('[OpenAI] Malformed /audio/transcriptions response:', raw.slice(0, 500));
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  if (typeof data?.text !== 'string') {
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  return { text: data.text };
};

// OpenAI text-to-speech. Returns base64-wrapped MP3 bytes.
export const textToSpeech = async ({ model, voice, speed, input }) => {
  const key = env.openAiApiKey;
  if (!key) throw throwFriendly(AI_AUDIO_KEY_MISSING_MESSAGE, 503);

  let res;
  try {
    res = await fetch(OPENAI_SPEECH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: model || 'tts-1', voice, speed, input, response_format: 'mp3' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    handleFetchError(err);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw classifyHttpError(res.status, raw);
  }
  const buffer = Buffer.from(await res.arrayBuffer().catch(() => Buffer.from('')));
  if (!buffer.length) throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  return { audio: buffer.toString('base64'), mediaType: 'audio/mpeg' };
};