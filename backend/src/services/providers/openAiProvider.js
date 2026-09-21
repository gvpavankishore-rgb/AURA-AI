import env from '../../config/env.js';

export const USER_ERROR_UNAVAILABLE = 'AI service is temporarily unavailable. Please try again.';
export const AI_KEY_MISSING_MESSAGE = 'AI image service is not configured. Set OPENAI_API_KEY in backend/.env.';
export const AI_INVALID_RESPONSE_MESSAGE = 'AI image service returned an invalid response. Please try again.';
export const AI_AUTH_ERROR_MESSAGE = 'AI image service authentication failed. Please verify the OpenAI API key.';
export const AI_BILLING_MESSAGE = 'Image generation is unavailable: OpenAI credits or billing limits reached.';
export const AI_RATE_LIMIT_MESSAGE = 'AI image service is rate limited. Please try again in a moment.';
export const AI_MODEL_UNAVAILABLE_MESSAGE = 'The image model is temporarily unavailable. Please try again.';
export const AI_TIMEOUT_MESSAGE = 'AI image service took too long to respond. Please try again.';
export const AI_NETWORK_MESSAGE = 'AI image service is unreachable. Please check your connection and try again.';

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

const OPENAI_IMAGES_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const REQUEST_TIMEOUT_MS = 120000;

// Real OpenAI Images API (https://platform.openai.com/docs/api-reference/images).
// The key lives in backend/.env as OPENAI_API_KEY and is never exposed to the
// frontend. Returns base64 PNG bytes so the route can persist + display it
// without leaking any API credentials.
export const createImage = async ({ model, prompt, size }) => {
  const key = env.openAiApiKey;
  if (!key) throw throwFriendly(AI_KEY_MISSING_MESSAGE, 503);

  const body = { model, prompt, n: 1 };
  if (size) body.size = size;

  let res;
  try {
    res = await fetch(OPENAI_IMAGES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || err?.message?.includes('aborted');
    console.error('[OpenAI] /images/generations network error:', timedOut ? 'timeout' : (err?.cause?.message || err?.message || err));
    throw throwFriendly(timedOut ? AI_TIMEOUT_MESSAGE : AI_NETWORK_MESSAGE, timedOut ? 504 : 503);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    console.error(`[OpenAI] /images/generations HTTP ${res.status}:`, raw.slice(0, 600) || '(no error body)');
    const combined = `${raw} ${res.status}`.toLowerCase();
    if (res.status === 401 || res.status === 403 || /authentication|unauthorized|invalid.*api key/i.test(combined)) {
      throw throwFriendly(AI_AUTH_ERROR_MESSAGE, 502);
    }
    // Insufficient quota / exhausted credits is a BILLING condition (OpenAI
    // returns 429 with code "insufficient_quota" / "credit_balance_exhausted"),
    // so it must be checked BEFORE the generic rate-limit rule below.
    if (res.status === 402 || res.status === 409 || /billing|payment|credit|insufficient.?quota|no credits/i.test(combined)) {
      throw throwFriendly(AI_BILLING_MESSAGE, 502);
    }
    if (res.status === 429 || /rate.?limit|too many requests/i.test(combined)) {
      throw throwFriendly(AI_RATE_LIMIT_MESSAGE, 502);
    }
    if ((res.status === 404 || res.status === 400) && /model.*not found|does not exist|no such model/i.test(combined)) {
      throw throwFriendly(AI_MODEL_UNAVAILABLE_MESSAGE, 502);
    }
    if (res.status >= 500) {
      throw throwFriendly(AI_MODEL_UNAVAILABLE_MESSAGE, 502);
    }
    throw throwFriendly(USER_ERROR_UNAVAILABLE, 502);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  const item = data?.data?.[0];
  if (!item || typeof item.b64_json !== 'string') {
    console.error('[OpenAI] Malformed /images/generations response:', raw.slice(0, 500));
    throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  }
  return {
    image: item.b64_json,
    mediaType: item.media_type || (item.b64_json.startsWith('iVBORw0KGgo') ? 'image/png' : 'image/png'),
    revisedPrompt: item.revised_prompt || null,
  };
};