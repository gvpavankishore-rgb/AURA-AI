import env from '../../config/env.js';

export const USER_ERROR_UNAVAILABLE = 'AI voice service is temporarily unavailable. Please try again.';
export const AI_AUDIO_KEY_MISSING_MESSAGE = 'Text-to-speech is not configured. Set ELEVENLABS_API_KEY in backend/.env.';
export const AI_PLAN_MESSAGE = 'Text-to-speech is unavailable: this voice requires an ElevenLabs paid plan. Upgrade your plan in your ElevenLabs account, or set a custom voice ID with ELEVENLABS_VOICE_ID in backend/.env.';
export const AI_INVALID_RESPONSE_MESSAGE = 'AI voice service returned an invalid response. Please try again.';
export const AI_AUTH_ERROR_MESSAGE = 'AI voice service authentication failed. Please verify the ElevenLabs API key.';
export const AI_RATE_LIMIT_MESSAGE = 'AI voice service is rate limited. Please try again in a moment.';
export const AI_MODEL_UNAVAILABLE_MESSAGE = 'The selected voice is unavailable. Please try a different voice.';
export const AI_TIMEOUT_MESSAGE = 'AI voice service took too long to respond. Please try again.';
export const AI_NETWORK_MESSAGE = 'AI voice service is unreachable. Please check your connection and try again.';

export const SAFE_ERRORS = new Set([
  USER_ERROR_UNAVAILABLE,
  AI_AUDIO_KEY_MISSING_MESSAGE,
  AI_PLAN_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AI_AUTH_ERROR_MESSAGE,
  AI_RATE_LIMIT_MESSAGE,
  AI_MODEL_UNAVAILABLE_MESSAGE,
  AI_TIMEOUT_MESSAGE,
  AI_NETWORK_MESSAGE,
]);

const throwFriendly = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const ELEVENLABS_TTS_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';
const REQUEST_TIMEOUT_MS = 120000;

// Map OpenAI-style voice names to ElevenLabs default (premade) voice IDs so the
// frontend can keep sending "alloy" while the provider resolves the real ID.
const PREMADE_VOICE_IDS = {
  alloy: '21m00Tcm4TlvDq8ikWAM',   // Rachel
  echo: 'AZnzlk1XvdvUeBnXmlld',     // Domi
  fable: 'EXAVITQu4vr4xnSDxMaL',    // Bella
  onyx: 'ErXwobaYiN019PkySvjV',     // Antoni
  nova: 'MF3mGyEYCl7XYWbV9V6O',     // Elli
  shimmer: 'TxGEqnHWrfWFTfGW9XjX',  // Josh
};

const resolveVoiceId = (voice) => {
  const raw = String(voice || '').trim();
  if (PREMADE_VOICE_IDS[raw]) return PREMADE_VOICE_IDS[raw];
  // A real ElevenLabs voice ID looks like a 20-character alphanumeric string.
  if (/^[a-zA-Z0-9]{20,}$/.test(raw)) return raw;
  if (env.elevenLabsVoiceId) return env.elevenLabsVoiceId;
  return '21m00Tcm4TlvDq8ikWAM';
};

const classifyHttpError = (status, raw) => {
  console.error(`[ElevenLabs] HTTP ${status}:`, raw.slice(0, 600) || '(no error body)');
  const combined = `${raw} ${status}`.toLowerCase();
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.*api key|no such api key|unauth/i.test(combined)) {
    return throwFriendly(AI_AUTH_ERROR_MESSAGE, 502);
  }
  // Free plan / paid-plan-gated voices and over-quota usage both come back as
  // 402 in various shapes. Separate the two so our message stays accurate.
  if (status === 402 || /paid_plan_required|payment_required|upgrade.*subscription|free users cannot/i.test(combined)) {
    if (/plan|subscription|free users|upgrade/i.test(combined)) return throwFriendly(AI_PLAN_MESSAGE, 502);
    return throwFriendly(AI_RATE_LIMIT_MESSAGE, 502);
  }
  if (status === 429 || /quota|rate.?limit|too many requests/i.test(combined)) {
    return throwFriendly(AI_RATE_LIMIT_MESSAGE, 502);
  }
  if (status === 400 || status === 404 || /voice.*not found|invalid.*voice/i.test(combined)) {
    return throwFriendly(AI_MODEL_UNAVAILABLE_MESSAGE, 502);
  }
  if (status >= 500) {
    return throwFriendly(USER_ERROR_UNAVAILABLE, 502);
  }
  return throwFriendly(USER_ERROR_UNAVAILABLE, 502);
};

// ElevenLabs text-to-speech. Returns base64-wrapped MP3 bytes.
export const textToSpeech = async ({ text, voice, speed }) => {
  const key = env.elevenLabsApiKey;
  if (!key) throw throwFriendly(AI_AUDIO_KEY_MISSING_MESSAGE, 503);

  const voiceId = resolveVoiceId(voice);
  const body = {
    text: String(text || ''),
    model_id: env.elevenLabsModelId || 'eleven_multilingual_v2',
  };
  if (speed && Number(speed) !== 1 && Number.isFinite(Number(speed))) {
    body.speed = Number(speed);
  }

  let res;
  try {
    res = await fetch(`${ELEVENLABS_TTS_ENDPOINT}/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': key,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || err?.message?.includes('aborted');
    console.error('[ElevenLabs] network error:', timedOut ? 'timeout' : (err?.cause?.message || err?.message || err));
    throw throwFriendly(timedOut ? AI_TIMEOUT_MESSAGE : AI_NETWORK_MESSAGE, timedOut ? 504 : 503);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw classifyHttpError(res.status, raw);
  }

  const buffer = Buffer.from(await res.arrayBuffer().catch(() => Buffer.from('')));
  if (!buffer.length) throw throwFriendly(AI_INVALID_RESPONSE_MESSAGE, 502);
  return { audio: buffer.toString('base64'), mediaType: 'audio/mpeg' };
};