import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
if (!hasSupabase) {
  console.warn('\n  ##############################################################');
  console.warn('  ##  SUPABASE_URL / SUPABASE_ANON_KEY are missing.            ##');
  console.warn('  ##  Database features (auth, chat history, uploads, memory)  ##');
  console.warn('  ##  will fail until valid Supabase credentials are set.      ##');
  console.warn('  ##  Add SUPABASE_URL and SUPABASE_ANON_KEY to backend/.env.  ##');
  console.warn('  ##############################################################\n');
}

const normalizeSupabaseUrl = (raw) => {
  if (!raw) return '';
  let url = String(raw).trim();
  const suffixMatch = url.match(/(\/rest\/v1|\/auth\/v1|\/storage\/v1)\/?$/i);
  if (suffixMatch) {
    const stripped = url.replace(new RegExp(`\\${suffixMatch[1]}\\/?$`, 'i'), '');
    console.warn('\n  ##############################################################');
    console.warn('  ##  WARNING: SUPABASE_URL contains an API path suffix.       ##');
    console.warn(`  ##    Got:    ${url}`);
    console.warn(`  ##    Fixed:  ${stripped}`);
    console.warn('  ##  Set the PROJECT base URL in backend/.env (no /rest/v1).  ##');
    console.warn('  ##############################################################\n');
    url = stripped;
  }
  return url.replace(/\/+$/, '');
};

const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-chat-v3-0324:free';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const aiProvider = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
const isOpenRouter = aiProvider === 'openrouter';

// OpenRouter two-key failover. OPENROUTER_API_KEY_1 is the primary key and
// OPENROUTER_API_KEY_2 is the backup; if a request fails with key 1 the same
// request is retried with key 2. The legacy single OPENROUTER_API_KEY (and
// AI_API_KEY / OPENAI_API_KEY) are kept for backward compatibility so existing
// deployments keep working after the migration.
const legacyAiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const openRouterApiKey1 = process.env.OPENROUTER_API_KEY_1 || process.env.OPENROUTER_API_KEY || legacyAiKey;
const openRouterApiKey2 = process.env.OPENROUTER_API_KEY_2 || '';
const openRouterKeys = openRouterApiKey2
  ? [openRouterApiKey1, openRouterApiKey2]
  : openRouterApiKey1
    ? [openRouterApiKey1]
    : [];
const openRouterApiKey = openRouterApiKey1;
const hasAiKey = openRouterKeys.length > 0;
if (!hasAiKey) {
  console.warn('\n  ##############################################################');
  console.warn('  ##  OPENROUTER_API_KEY is missing.                          ##');
  console.warn('  ##  Chat, image, and voice AI features will be unavailable  ##');
  console.warn('  ##  until a valid OpenRouter API key is set.                ##');
  console.warn('  ##  Get one at: https://openrouter.ai/keys                  ##');
  console.warn('  ##  OPENROUTER_API_KEY is used server-side only and is     ##');
  console.warn('  ##  never exposed to the frontend.                          ##');
  console.warn('  ##############################################################\n');
}

const openRouterBaseUrl = (process.env.OPENROUTER_BASE_URL || process.env.AI_BASE_URL || OPENROUTER_BASE_URL).replace(/\/+$/, '');

// All model names are read from the environment (first sourced from the
// OpenRouter-specific vars, then from the legacy AI_* vars). Never hardcode.
const aiModel = process.env.OPENROUTER_MODEL || process.env.AI_MODEL || DEFAULT_OPENROUTER_MODEL;

// The main chat model may NOT be vision-capable (e.g. deepseek chat models),
// so image analysis uses a dedicated vision model. If AI_VISION_MODEL is not
// set, fall back to a widely available OpenRouter vision model instead of the
// (non-vision) chat model so image uploads actually work out of the box.
const visionSuffixMatch = String(aiModel).toLowerCase().match(/\b(vl|vision)\b/);
const DEFAULT_VISION_MODEL = isOpenRouter ? (visionSuffixMatch ? aiModel : 'openai/gpt-4o-mini') : 'gpt-4o';
const hasExplicitVisionModel = Boolean(process.env.AI_VISION_MODEL);
if (!hasExplicitVisionModel) {
  console.warn('  [AURA] AI_VISION_MODEL not set - using default vision model: ' + DEFAULT_VISION_MODEL);
  console.warn('  [AURA] Set AI_VISION_MODEL in backend/.env if you use a different vision-capable model.');
}

// Image upload + vision analysis uses a vision-capable OpenRouter model (see
// AI_VISION_MODEL above). OPENAI_API_KEY (when present) is only used for
// optional direct-OpenAI voice features (whisper / tts).
const openAiApiKey = process.env.OPENAI_API_KEY || '';
if (!openAiApiKey) {
  console.warn('\n  ##############################################################');
  console.warn('  ##  OPENAI_API_KEY is optional.                            ##');
  console.warn('  ##  It is only needed for direct-OpenAI voice features     ##');
  console.warn('  ##  (whisper / tts); without it voice falls back to        ##');
  console.warn('  ##  OpenRouter / ElevenLabs.                               ##');
  console.warn('  ##############################################################\n');
}

// Optional ElevenLabs text-to-speech (ELEVENLABS_API_KEY). When set, TTS uses
// ElevenLabs first; otherwise OpenAI TTS and then OpenRouter are tried.
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || '';

// Allowed CORS origins. CLIENT_URL may hold a comma-separated allow-list so a
// single deployed backend can serve both the local dev origin
// (http://localhost:5173) and the production frontend (the Render static site
// origin). Defaults to the local dev origin so nothing breaks out of the box.
const clientUrlRaw = process.env.CLIENT_URL || 'http://localhost:5173';
const clientOrigins = clientUrlRaw.split(',').map(s => s.trim()).filter(Boolean);

export default {
  port: process.env.PORT || 5001,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: clientUrlRaw,
  clientOrigins,
  supabaseUrl: normalizeSupabaseUrl(process.env.SUPABASE_URL),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  hasSupabase,
  aiProvider,
  isOpenRouter,
  aiApiKey: openRouterApiKey,
  hasAiKey,
  openRouterApiKey,
  openRouterApiKey1,
  openRouterApiKey2,
  openRouterKeys,
  openRouterBaseUrl,
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL || process.env.CLIENT_URL || 'http://localhost:5173',
  openRouterAppName: process.env.OPENROUTER_APP_NAME || 'AURA AI',
  aiModel,
  aiVisionModel: process.env.AI_VISION_MODEL || DEFAULT_VISION_MODEL,
  openAiApiKey,
  aiTranscribeModel: process.env.AI_TRANSCRIBE_MODEL || (process.env.OPENAI_API_KEY ? 'whisper-1' : (isOpenRouter ? 'openai/whisper-large-v3' : 'whisper-1')),
  aiTtsModel: process.env.AI_TTS_MODEL || 'tts-1',
  elevenLabsApiKey,
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
  webSearch: {
    enabled: process.env.WEB_SEARCH_ENABLED === 'true',
    provider: String(process.env.WEB_SEARCH_PROVIDER || 'tavily').toLowerCase(),
    tavilyApiKey: process.env.TAVILY_API_KEY || '',
  },
  weather: {
    provider: String(process.env.WEATHER_PROVIDER || 'openweather').toLowerCase(),
    apiKey: process.env.WEATHER_API_KEY || '',
  },
};

const requiredInProduction = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
];

export const validateEnv = () => {
  if (process.env.NODE_ENV !== 'production') return;

  const missing = requiredInProduction.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  if (process.env.NODE_ENV === 'production'
    && !process.env.OPENROUTER_API_KEY_1
    && !process.env.OPENROUTER_API_KEY_2
    && !process.env.OPENROUTER_API_KEY) {
    missing.push('OPENROUTER_API_KEY_1 (or OPENROUTER_API_KEY)');
  }
  if (missing.length === 0) return;

  const lines = [
    '',
    '  AURA AI failed to start — missing required environment variables:',
    '',
    ...missing.map((k) => `    - ${k}`),
    '',
    '  Set them in backend/.env and restart the server.',
    '',
  ];
  throw new Error(lines.join('\n'));
};