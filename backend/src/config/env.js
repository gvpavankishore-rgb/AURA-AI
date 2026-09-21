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

// OpenRouter key is the primary AI key. Legacy provider-agnostic
// AI_API_KEY / OPENAI_API_KEY are kept ONLY for backward compatibility so
// existing deployments keep working after the migration.
const legacyAiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const openRouterApiKey = process.env.OPENROUTER_API_KEY || legacyAiKey;
const hasAiKey = Boolean(openRouterApiKey);
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

export default {
  port: process.env.PORT || 5001,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  supabaseUrl: normalizeSupabaseUrl(process.env.SUPABASE_URL),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  hasSupabase,
  aiProvider,
  isOpenRouter,
  aiApiKey: openRouterApiKey,
  hasAiKey,
  openRouterApiKey,
  openRouterBaseUrl,
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL || process.env.CLIENT_URL || 'http://localhost:5173',
  openRouterAppName: process.env.OPENROUTER_APP_NAME || 'AURA AI',
  aiModel,
  aiVisionModel: process.env.AI_VISION_MODEL || DEFAULT_VISION_MODEL,
  aiImageModel: process.env.AI_IMAGE_MODEL || (isOpenRouter ? 'openai/gpt-image-1' : 'dall-e-3'),
  aiTranscribeModel: process.env.AI_TRANSCRIBE_MODEL || (isOpenRouter ? 'openai/whisper-large-v3' : 'whisper-1'),
  aiTtsModel: process.env.AI_TTS_MODEL || (isOpenRouter ? 'openai/gpt-4o-mini-tts-2025-12-15' : 'tts-1'),
};

const requiredInProduction = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'OPENROUTER_API_KEY',
];

export const validateEnv = () => {
  if (process.env.NODE_ENV !== 'production') return;

  const missing = requiredInProduction.filter((k) => !process.env[k] || !String(process.env[k]).trim());
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