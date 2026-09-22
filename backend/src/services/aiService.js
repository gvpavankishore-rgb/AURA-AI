import env from '../config/env.js';
import fs from 'fs';
import path from 'path';
import * as openRouter from './providers/openRouterProvider.js';
import * as openAi from './providers/openAiProvider.js';
import * as elevenLabs from './providers/elevenLabsProvider.js';
import { getDeveloperContextPrompt } from './developerInfo.js';
import { isCodingRequest, isVisionHint } from './intentDetector.js';

export const isSafeAiErrorMessage = openRouter.isSafeAiErrorMessage;

const USER_ERROR_UNAVAILABLE = openRouter.USER_ERROR_UNAVAILABLE;

const imageMimeFromPath = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
};

export const hasImageAttachments = (attachments) =>
  (attachments || []).some(
    (att) =>
      att &&
      (att.type === 'image' || (att.mimetype && att.mimetype.startsWith('image/')) || /^image\/(png|jpe?g|webp)$/i.test(att.mimetype || ''))
  );

const buildUserContent = (text, attachments) => {
  if (!attachments || attachments.length === 0) return text;

  const parts = [];
  if (text) parts.push({ type: 'text', text });

  for (const att of attachments) {
    if (!att || !att.path) continue;
    const isImage = att.type === 'image' || (att.mimetype && att.mimetype.startsWith('image/'));
    if (!isImage) continue;
    try {
      const buffer = fs.readFileSync(path.resolve(process.cwd(), att.path));
      const base64 = buffer.toString('base64');
      const mime = att.mimetype || imageMimeFromPath(att.path);
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
    } catch (err) {
      console.error('[AI Vision] Could not read image attachment:', err.message);
    }
  }

  return parts.length ? parts : text;
};

const VISION_SYSTEM_PROMPT = `
You are an expert multimodal (vision) AI. When the user attaches an image, examine it carefully and follow the intent of their prompt. If no prompt is given, describe the image in detail.

Depending on the image content:
- UI / web design screenshot -> Output the EXACT HTML/CSS, React, or plain HTML code that reproduces the design pixel-perfectly (layout, colors, spacing, fonts, buttons, responsiveness).
- Programming / code screenshot -> Output the complete, syntactically-correct working code shown in the image, and fix any visible issues.
- Error / exception screenshot -> Identify the ROOT CAUSE and provide the exact fix, with corrected code.
- General picture / photo -> Provide a clear, natural description.
- Design mockup / logo / illustration -> Recreate the same design using the best available code (HTML/CSS/SVG for 2D designs).

Whenever code is involved, also provide: the file structure, the commands needed to install dependencies, how to run the project, and a short explanation.`

const CODING_MODE_PROMPT = `
You are a senior software engineer. Provide production-quality, complete working code with clear explanations.

When answering coding requests ALWAYS include, when applicable:
1. The complete code in fenced code blocks with the correct language tag.
2. The file structure (list every file needed).
3. Installation commands (npm install / pip install / etc).
4. How to run the project (dev server, CLI command, etc).
5. A short explanation of how the code works.

Support JavaScript, TypeScript, React, Node.js, Express, Python, Java, C, C++, C#, Go, Rust, PHP, Ruby, SQL, HTML, CSS, Bash, and more. Keep the code idiomatic and free of placeholder TODOs unless the user explicitly asks for stubs.`;

const getSystemPrompt = ({ mode = 'chat', memories = [], documents = [], vision = false, coding = false, webSearchText = '' } = {}) => {
  const base = `You are AURA, a helpful, intelligent, and professional AI assistant. You provide clear, accurate, and well-structured responses. You support coding, image analysis, document analysis, translation, and general conversation.${getDeveloperContextPrompt()}`;
  const memoryContext = memories.length > 0 ? `\n\nUser preferences and context:\n${memories.join('\n')}` : '';
  const documentContext = documents.length > 0
    ? `\n\nYou have access to these documents from the conversation. Use them to answer questions about the uploaded files.\n${documents.map(d => `[Document: ${d.filename}]\n${d.text}`).join('\n\n')}`
    : '';

  const webSearchContext = webSearchText
    ? `\n\nYou have been given information retrieved live from the web to answer the user's question about current or recent information.\n\nInstructions:\n- Use the retrieved web results as your PRIMARY source of truth for this answer.\n- Do NOT say you lack internet access, and do not fabricate facts, figures, dates, or prices.\n- Answer naturally and concisely using only what the retrieved results support.\n- If the user asked about weather, use the retrieved results for the location they asked about.\n- When you cite something from a result, mention the source name inline where it adds clarity (the clickable URLs are shown to the user separately).\n\n[Web Search Results]\n${webSearchText}`
    : '';

  let modePrompt = '';
  if (mode === 'coding' || coding) modePrompt = CODING_MODE_PROMPT;
  else if (mode === 'voice') modePrompt = '\n\nThe user is interacting via voice. Keep responses conversational and concise.';
  else if (mode === 'documents') modePrompt = '\n\nYou are analyzing documents. Reference specific content from the document when answering.';
  else if (mode === 'translate') modePrompt = '\n\nYou are a professional translator. Provide accurate, natural translations.';

  const visionPrompt = vision ? VISION_SYSTEM_PROMPT : '';

  return base + modePrompt + visionPrompt + memoryContext + documentContext + webSearchContext;
};

const buildHistoryMessages = ({ messages, userContent, attachments }) => {
  const history = (messages || []).slice(-30).map(m => ({
    role: ['assistant', 'system'].includes(m.role) ? m.role : 'user',
    content: String(m.content || ''),
  }));
  if (userContent && history.length > 0 && history[history.length - 1].role === 'user') {
    history[history.length - 1].content = userContent;
  }
  if (attachments && attachments.length > 0 && history.length > 0) {
    const last = history[history.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      last.content = buildUserContent(last.content, attachments);
    }
  }
  for (const m of history) {
    if (m.role === 'user' && typeof m.content === 'string' && !m.content.trim()) {
      m.content = 'Please analyze the attached file or image.';
    }
  }
  return history;
};

const consumeStream = (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return (async function* () {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return;
          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          if (chunk?.error) throw openRouter.mapStreamError(chunk.error);
          const delta = chunk?.choices?.[0]?.delta?.content;
          const finish = chunk?.choices?.[0]?.finish_reason;
          if (typeof delta === 'string' && delta.length > 0) yield delta;
          if (finish === 'error') throw openRouter.mapStreamError(chunk?.error || { code: 502, message: 'Generation failed mid-stream' });
          if (finish === 'stop') return;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  })();
};

export const processMessage = async ({ messages, memories = [], mode = 'chat', attachments, userContent, stream = false, documents = [], webSearch = null }) => {
  const content = String(userContent || '').trim();
  const vision = hasImageAttachments(attachments) || isVisionHint(content);
  const coding = mode === 'coding' || isCodingRequest(content);
  const effectiveMode = coding ? 'coding' : mode;

  const sources = Array.isArray(webSearch?.sources) ? webSearch.sources : [];
  const webSearchText = String(webSearch?.text || '').trim();

  const requestModel = vision ? env.aiVisionModel : env.aiModel;
  const maxTokens = (vision || coding) ? 8192 : 4096;
  const systemPrompt = getSystemPrompt({
    mode: effectiveMode,
    memories,
    documents,
    vision,
    coding,
    webSearchText,
  });

  if (!env.hasAiKey) {
    const rethrown = new Error(openRouter.AI_KEY_MISSING_MESSAGE);
    rethrown.statusCode = 502;
    if (stream) throw rethrown;
    return { content: openRouter.AI_KEY_MISSING_MESSAGE, metadata: { provider: env.aiProvider, error: 'missing_api_key' } };
  }

  const history = buildHistoryMessages({ messages, userContent, attachments });
  const requestMessages = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  try {
    if (stream) {
      const response = await openRouter.chatCompletions({ model: requestModel, messages: requestMessages, stream: true, max_tokens: maxTokens });
      return consumeStream(response);
    }
    const response = await openRouter.chatCompletions({ model: requestModel, messages: requestMessages, stream: false, max_tokens: maxTokens });
    const raw = await response.text().catch(() => '');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(openRouter.AI_INVALID_RESPONSE_MESSAGE);
    }
    if (data?.error) throw openRouter.mapStreamError(data.error);
    const aiContent = data?.choices?.[0]?.message?.content;
    if (typeof aiContent !== 'string') {
      console.error('[AI Service] Malformed response:', raw.slice(0, 500));
      throw new Error(openRouter.AI_INVALID_RESPONSE_MESSAGE);
    }
    return {
      content: aiContent,
      metadata: {
        provider: env.aiProvider,
        model: data.model || requestModel,
        usage: data.usage,
        ...(sources.length > 0 ? { webSearch: { used: true, sources } } : {}),
      },
    };
  } catch (err) {
    console.error('[AI Service Error]', err?.message || err);
    const friendly = openRouter.SAFE_ERRORS.has(err.message) ? err.message : USER_ERROR_UNAVAILABLE;
    if (stream) {
      return (async function* () {
        yield friendly;
      })();
    }
    const rethrown = new Error(friendly);
    rethrown.statusCode = err.statusCode || 502;
    throw rethrown;
  }
};

const IMAGE_GEN_NOT_CONFIGURED = 'OpenRouter image generation is not configured.';
const IMAGE_GEN_CREDITS = 'OpenRouter image generation requires available credits.';
const IMAGE_GEN_AUTH = 'OpenRouter authentication failed for image generation.';
const IMAGE_GEN_RATE_LIMIT = 'Image generation is temporarily rate limited. Please try again.';
const IMAGE_GEN_UNAVAILABLE = 'Image generation service is temporarily unavailable.';

// Image generation always goes through OpenRouter's dedicated images endpoint
// (POST /images) using the existing OPENROUTER_API_KEY_1 -> OPENROUTER_API_KEY_2
// two-account failover implemented in the OpenRouter provider. The direct
// OpenAI Images API is intentionally NOT used, so image generation can never
// depend on OPENAI_API_KEY or OpenAI billing.
export const generateImage = async (prompt) => {
  if (!env.hasAiKey) {
    const err = new Error(IMAGE_GEN_NOT_CONFIGURED);
    err.statusCode = 503;
    throw err;
  }
  try {
    return await openRouter.createImage({ model: env.openRouterImageModel, prompt });
  } catch (err) {
    // Safe backend-only log of the underlying (already sanitised) cause. The
    // client is told the real reason (missing keys / credits / auth / rate
    // limit) without ever exposing provider secrets or raw error bodies.
    console.error('[Image Generation] OpenRouter image generation failed:', err?.statusCode ? `HTTP ${err.statusCode}` : `network ${err?.message || err}`);
    let friendly = IMAGE_GEN_UNAVAILABLE;
    if (err?.message === openRouter.AI_BILLING_MESSAGE) friendly = IMAGE_GEN_CREDITS;
    else if (err?.message === openRouter.AI_AUTH_ERROR_MESSAGE) friendly = IMAGE_GEN_AUTH;
    else if (err?.message === openRouter.AI_RATE_LIMIT_MESSAGE) friendly = IMAGE_GEN_RATE_LIMIT;
    const rethrown = new Error(friendly);
    rethrown.statusCode = err?.statusCode && err.statusCode > 500 ? err.statusCode : 502;
    throw rethrown;
  }
};

export const analyzeImage = async (imagePath, question) => {
  if (!env.hasAiKey) throw new Error(openRouter.AI_KEY_MISSING_MESSAGE);

  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

  const userQuestion = String(question || '').trim() || 'Describe this image in detail.';
  const visionPrompt = getSystemPrompt({ vision: true, coding: isCodingRequest(userQuestion) });

  const response = await openRouter.chatCompletions({
    model: env.aiVisionModel,
    messages: [
      { role: 'system', content: visionPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userQuestion },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
    stream: false,
    max_tokens: 8192,
  });

  const raw = await response.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(openRouter.AI_INVALID_RESPONSE_MESSAGE);
  }
  if (data?.error) throw openRouter.mapStreamError(data.error);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(openRouter.AI_INVALID_RESPONSE_MESSAGE);
  }
  return { content };
};

export const transcribeAudio = async (audioPath) => {
  let formData;
  try {
    formData = new FormData();
    formData.append('file', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
    formData.append('model', env.aiTranscribeModel);
  } catch (err) {
    console.error('[STT] Could not read audio file:', err?.message || err);
    const rethrown = new Error('Could not read the audio file. Please upload a valid recording.');
    rethrown.statusCode = 400;
    throw rethrown;
  }

  try {
    // Speech-to-text: OpenAI Whisper first (needs OPENAI_API_KEY with credits),
    // then OpenRouter /audio/transcriptions (needs OpenRouter balance).
    if (env.openAiApiKey) {
      return await openAi.transcribeAudio({ model: env.aiTranscribeModel, formData });
    }
    if (env.hasAiKey) {
      return await openRouter.transcribeAudio({ model: env.aiTranscribeModel, formData });
    }
    const err = new Error('Voice-to-text is not configured. Set OPENAI_API_KEY in backend/.env (or add OpenRouter credits for whisper).');
    err.statusCode = 503;
    throw err;
  } catch (err) {
    if (err && err.statusCode) throw err;
    const friendly = openRouter.SAFE_ERRORS.has(err.message) ? err.message : openRouter.USER_ERROR_UNAVAILABLE;
    const rethrown = new Error(friendly);
    rethrown.statusCode = err.statusCode || 502;
    throw rethrown;
  }
};

export const textToSpeech = async (text, voice = 'alloy', speed = 1) => {
  try {
    // Text-to-speech: ElevenLabs when its key is set, else OpenAI TTS (needs
    // credits), else OpenRouter /audio/speech (needs balance + valid model).
    if (env.elevenLabsApiKey) {
      return await elevenLabs.textToSpeech({ text, voice, speed });
    }
    if (env.openAiApiKey) {
      return await openAi.textToSpeech({ model: env.aiTtsModel, voice, speed, input: text });
    }
    if (env.hasAiKey) {
      const orModel = String(env.aiTtsModel || '').includes('/') ? env.aiTtsModel : `openai/${env.aiTtsModel || 'tts-1'}`;
      return await openRouter.textToSpeech({ model: orModel, voice, speed, input: text });
    }
    const err = new Error('Text-to-speech is not configured. Set ELEVENLABS_API_KEY or OPENAI_API_KEY in backend/.env.');
    err.statusCode = 503;
    throw err;
  } catch (err) {
    if (err && err.statusCode) throw err;
    const friendly = openRouter.SAFE_ERRORS.has(err.message) ? err.message : openRouter.USER_ERROR_UNAVAILABLE;
    const rethrown = new Error(friendly);
    rethrown.statusCode = err.statusCode || 502;
    throw rethrown;
  }
};