import env from '../config/env.js';
import fs from 'fs';
import path from 'path';
import * as openRouter from './providers/openRouterProvider.js';
import * as openAi from './providers/openAiProvider.js';
import * as elevenLabs from './providers/elevenLabsProvider.js';
import { getDeveloperContextPrompt } from './developerInfo.js';
import { APPLICATION_CONTEXT } from './applicationContext.js';
import { isCodingRequest, isVisionHint } from './intentDetector.js';
import { formatNowInTimezone } from './dateTimeService.js';
import { buildUrlAllowlist, sanitizeLinks, createLinkSanitizer } from './webSearchService.js';
import { groundAnswer, createGroundedStream } from './answerGrounder.js';
import { buildResource, captureResourceStream, extractResourceBlock } from './resourceCard.js';
import * as storageService from './storageService.js';

export const isSafeAiErrorMessage = openRouter.isSafeAiErrorMessage;

const USER_ERROR_UNAVAILABLE = openRouter.USER_ERROR_UNAVAILABLE;

const imageMimeFromPath = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
};

const normalizeImageMime = (mimetype, filePath = '') => {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return mime;
  return imageMimeFromPath(filePath);
};

export const hasImageAttachments = (attachments) =>
  (attachments || []).some(
    (att) =>
      att &&
      (att.type === 'image' || (att.mimetype && att.mimetype.startsWith('image/')) || /^image\/(png|jpe?g|webp)$/i.test(att.mimetype || ''))
  );

const buildUserContent = async (text, attachments) => {
  if (!attachments || attachments.length === 0) return text;

  const parts = [];
  if (text) parts.push({ type: 'text', text });

  for (const att of attachments) {
    if (!att || !att.path) continue;
    const isImage = att.type === 'image' || (att.mimetype && att.mimetype.startsWith('image/'));
    if (!isImage) continue;
    try {
      // Image bytes live in Supabase Storage, never on disk. Legacy rows that
      // still hold an `uploads/...` disk path are read from disk for the
      // transition period; everything new goes through storageService.
      let buffer;
      if (String(att.path).startsWith('user-')) {
        buffer = await storageService.downloadBuffer(att.path);
      } else {
        buffer = fs.readFileSync(path.resolve(process.cwd(), att.path));
      }
      const base64 = buffer.toString('base64');
      const mime = normalizeImageMime(att.mimetype, att.path);
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
    } catch (err) {
      console.error('[AI Vision] Could not read image attachment:', err?.message || err);
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

const buildServerClockText = () => {
  const now = new Date();
  const defaultTz = env.defaultTimezone || 'Asia/Kolkata';
  const parts = [];
  try {
    const local = formatNowInTimezone({ now, timezone: defaultTz, kind: 'both' });
    const utc = formatNowInTimezone({ now, timezone: 'UTC', kind: 'both' });
    if (local) parts.push(`- App timezone (${defaultTz}): ${local}`);
    if (utc) parts.push(`- UTC: ${utc}`);
  } catch {
    return '';
  }
  if (parts.length === 0) return '';
  return `\n\n[Current date and time — provided by the SERVER at the time of this request; always treat this as the authoritative clock. NEVER guess today's date, the day of the week, or the current time from your own knowledge.]\n${parts.join('\n')}`;
};

// Injected when a web search ran but produced no usable evidence. It explains
// that there are two knowledge sources and forbids exposing the empty search:
// the model answers about the assistant/application or from stable general
// knowledge, and only admits missing evidence when the request truly needs
// current/external facts. There is deliberately no question list here - the
// decision is made from the user's intent and the source of the information.
const NO_EVIDENCE_PROMPT = `

A live web search was already performed for this message, but it returned no usable results. Treat this ONLY as "there is no web evidence for this answer". It does NOT mean the whole answer must be about the search, and you must NEVER mention the search, say that it found nothing, or expose any internal detail, unless the user explicitly asks about the search itself.

Two different knowledge sources exist, and they are not the same:
1. Application context (about AURA itself), provided above: who the assistant is, its purpose, what it can do, its features, how it works, and its creator. This is a valid, trusted source. When the user asks about you, the assistant or the AURA application itself - your identity, purpose, abilities, features, how you work, or who made you - answer naturally and confidently from this context.
2. Stable general knowledge: well-established facts that do not depend on the current date, live prices, versions, news or any other time-sensitive detail. You may answer these naturally too.

Rules:
- Work out what the user is actually asking. If it can be answered from the application context or from stable general knowledge, answer it directly and do NOT mention the search at all.
- Do NOT invent, guess or construct current or external facts (news, current events, live prices, versions, releases, statistics, product specifications, laws, rankings, or any specific present-day fact). If the request genuinely depends on current or external web information that you cannot verify, say briefly and naturally that you could not reliably confirm it - do not state a specific unverified detail and do not use a technical-sounding notice.
- Never include a URL, link, domain or citation: no URL is available, so include none and never present a source.
- If the request is for a specific resource (a link, video, page or file) and none is available, say you could not find a relevant resource; never invent one.
- Never say you lack real-time access, cannot browse the internet, have a knowledge cutoff, or are answering from training data.
- Keep the answer natural, polished and in the user's language.`;

export const getSystemPrompt = ({ mode = 'chat', memories = [], documents = [], vision = false, coding = false, webSearchText = '', webSearchHasResults = true } = {}) => {
  // Server-provided current date/time block. This is the authoritative clock
  // for anything time-related; it is clearly separated from the model's own
  // knowledge so the LLM never answers "what time/date is it?" from memory.
  const serverClockText = buildServerClockText();
  const base = `You are AURA, a helpful, intelligent, and professional AI assistant. You provide clear, accurate, and well-structured responses. You support coding, image analysis, document analysis, translation, and general conversation.${serverClockText}${getDeveloperContextPrompt()}${APPLICATION_CONTEXT}`;
  const memoryContext = memories.length > 0 ? `\n\nUser preferences and context:\n${memories.join('\n')}` : '';
  const documentContext = documents.length > 0
    ? `\n\nYou have access to these documents from the conversation. Use them to answer questions about the uploaded files.\n${documents.map(d => `[Document: ${d.filename}]\n${d.text}`).join('\n\n')}`
    : '';

  const webSearchContext = webSearchText && !webSearchHasResults
    ? NO_EVIDENCE_PROMPT
    : webSearchText
    ? `\n\nA live web search was already performed for this message.The numbered block below (sources 1..n, in the same order as the Sources panel shown with your answer) is the EVIDENCE for your answer.\n\nGrounding rules (mandatory - they override everything above):\n- The evidence is the SOURCE OF TRUTH. Every factual claim you make must be supported by at least one retrieved result and cited as [n], where n is the number of that result. Never invent a citation number.\n- If a statement is not in the evidence, do not state it: leave it out, or say plainly that the available search results do not confirm it. Never fill a gap from your own memory or older knowledge, and never add companies, products, features, versions, dates, statistics, regulations, reports, benchmarks, organizations, people, numbers, URLs or citations just to make the answer look more complete.\n- A result mentioning an entity does not support any other property of that entity - only what that result actually states.\n- For "latest / current / today / now" questions, use only what the evidence says; if it does not cover that moment, say the search results do not confirm it.\n- If the results disagree with each other, keep both claims and attribute each one to its source ([1] vs [2]) instead of picking one silently or inventing a reconciliation. Prefer authoritative primary sources and the freshest information the evidence offers.\n- Tables, lists, comparisons and recommendations: every row, item and point must be supported by the evidence and cited; delete anything that is not.\n- Do not write "according to reports", "industry sources say", "experts say", "widely used" or "latest report" unless the evidence explicitly says it.\n- Never present hypothetical, fan-made or illustrative material as a real current fact unless the user explicitly asks for it.\n- NEVER say that you lack real-time access, cannot browse the internet, have a knowledge cutoff, or are answering from training data. The search was already executed for this request.\n- LINKS: only a URL that appears verbatim in the evidence may be used as a markdown link. Never invent, guess or construct a URL or ID of any kind; if no suitable URL is in the evidence, include no link. Include links only when they genuinely help the user.\n- First work out what the user is actually asking - their full intent, including anything implied. The message may be a short follow-up: use the conversation history to resolve what it refers to and answer only the current request.\n- Never substitute a different subject or entity than the one the user asked about. If the results are about another subject, say the search did not find that subject instead of answering about the other one.\n- Select the results that are genuinely relevant and ignore the rest; then SYNTHESIZE a natural answer in your own words instead of pasting snippets back.\n- Answer in the same language the user used, and honour any language they explicitly ask for.\n- Mention the source name inline where it adds clarity; cite supporting claims with [n] and keep the clickable URLs to the evidence.\n- If the evidence is thin, off-topic or conflicting, say so clearly instead of guessing. If the block says the search returned no results, tell the user the web search found nothing for their question and do not speculate.\n- The server clock above is authoritative for today's date and time; if a result mentions a date that has already passed, do not present it as an upcoming event.\n\nRESOURCE CARD:\n- Only when the user is asking for a specific directly useful thing and one of the results IS that thing (a trailer or video, an official website, documentation, a repository, a product page, an article, a map, a booking page, a downloadable file...), end your answer with exactly one block in this format:\n::RESOURCE\n{"type":"...","title":"...","description":"...","primaryLink":"...","primaryLinkLabel":"...","images":["..."],"metadata":[{"label":"...","value":"..."}],"source":"..."}\n::END\n- "type": the kind of resource, inferred from the user's intent and the result, one of: video, movie_trailer, website, documentation, repository, product, article, map, booking, download, other.\n- "primaryLink": copy EXACTLY the URL of the result that is the resource. Never build, guess or modify a URL.\n- "images": copy EXACTLY URL(s) from the image list in the evidence that belong to the selected resource; use [] when none fit. Never build or guess an image URL.\n- "title", "description" and every "metadata" label/value must come from the results. At most 6 short metadata pairs, and only pairs whose value is stated in the results.\n- "primaryLinkLabel": a short UI label for the link (for example "Watch trailer"); never put a URL in it.\n- If no single result is the directly useful thing the user asked for - for example a normal informational question - do NOT output a resource block at all.\n- Output the block only once, put it after all other text, and never explain or mention it.\n\n[Web Search Results]\n${webSearchText}`
    : '';

  let modePrompt = '';
  if (mode === 'coding' || coding) modePrompt = CODING_MODE_PROMPT;
  else if (mode === 'voice') modePrompt = '\n\nThe user is interacting via voice. Keep responses conversational and concise.';
  else if (mode === 'documents') modePrompt = '\n\nYou are analyzing documents. Reference specific content from the document when answering.';
  else if (mode === 'translate') modePrompt = '\n\nYou are a professional translator. Provide accurate, natural translations.';

  const visionPrompt = vision ? VISION_SYSTEM_PROMPT : '';

  return base + modePrompt + visionPrompt + memoryContext + documentContext + webSearchContext;
};

const buildHistoryMessages = async ({ messages, userContent, attachments }) => {
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
      last.content = await buildUserContent(last.content, attachments);
    }
  }
  for (const m of history) {
    if (m.role === 'user' && typeof m.content === 'string' && !m.content.trim()) {
      m.content = 'Please analyze the attached file or image.';
    }
  }
  return history;
};

// Parse the provider's SSE stream into raw text deltas (no rewriting).
const parseStream = (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return (async function* () {
    let stopped = false;
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') { stopped = true; break; }
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
          if (finish === 'stop') { stopped = true; break; }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  })();
};

// Apply the streaming link sanitizer to a raw text stream. `allowedUrls` is a
// Set when a search ran (possibly empty for zero results), otherwise null and
// the text is passed through untouched.
const sanitizeStream = (rawStream, allowedUrls = null) => {
  const sanitizer = allowedUrls instanceof Set ? createLinkSanitizer(allowedUrls) : null;
  if (!sanitizer) return rawStream;
  return (async function* () {
    for await (const chunk of rawStream) {
      const out = sanitizer.push(chunk);
      if (out) yield out;
    }
    const tail = sanitizer.flush();
    if (tail) yield tail;
  })();
};

export const processMessage = async ({ messages, memories = [], mode = 'chat', attachments, userContent, stream = false, documents = [], webSearch = null }) => {
  const content = String(userContent || '').trim();
  const vision = hasImageAttachments(attachments) || isVisionHint(content);
  const coding = mode === 'coding' || isCodingRequest(content);
  const effectiveMode = coding ? 'coding' : mode;

  const sources = Array.isArray(webSearch?.sources) ? webSearch.sources : [];
  const images = Array.isArray(webSearch?.images) ? webSearch.images : [];
  const webSearchText = String(webSearch?.text || '').trim();
  // Link accuracy: when a search ran, the only URLs allowed to appear as
  // links are the ones that search returned. `null` means no search ran
  // (translate/document/voice flows) and nothing is rewritten.
  const allowedUrls = webSearch ? buildUrlAllowlist(sources) : null;
  // Evidence grounding: when a search ran, the retrieved results are the only
  // source of truth for the answer. The draft is checked against them on both
  // the streaming and the non-streaming path. `null` = no search ran, so
  // translate/document/voice answers are left untouched.
  const grounding = webSearch
    ? { question: content, evidence: webSearchText, sources }
    : null;

  const requestModel = vision ? env.aiVisionModel : env.aiModel;
  const maxTokens = (vision || coding) ? 8192 : 4096;
  const systemPrompt = getSystemPrompt({
    mode: effectiveMode,
    memories,
    documents,
    vision,
    coding,
    webSearchText,
    webSearchHasResults: sources.length > 0,
  });

  if (!env.hasAiKey) {
    const rethrown = new Error(openRouter.AI_KEY_MISSING_MESSAGE);
    rethrown.statusCode = 502;
    if (stream) throw rethrown;
    return { content: openRouter.AI_KEY_MISSING_MESSAGE, metadata: { provider: env.aiProvider, error: 'missing_api_key' } };
  }

  const history = await buildHistoryMessages({ messages, userContent, attachments });
  const requestMessages = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  try {
    if (stream) {
      const response = await openRouter.chatCompletions({ model: requestModel, messages: requestMessages, stream: true, max_tokens: maxTokens });
      // Pipeline order matters:
      //   raw deltas -> pull out the ::RESOURCE block (so its URLs/sanitizing
      //   are handled by the card layer, not by the link filter)
      //   -> link sanitizer -> evidence grounding.
      const sink = { raw: null };
      const captured = captureResourceStream(parseStream(response), sink);
      const safeStream = sanitizeStream(captured, allowedUrls);
      const finalStream = grounding ? createGroundedStream(grounding, safeStream) : safeStream;

      let resolveResource;
      const resourcePromise = new Promise((resolve) => { resolveResource = resolve; });
      const out = (async function* () {
        try {
          for await (const chunk of finalStream) yield chunk;
        } finally {
          resolveResource(buildResource({ raw: sink.raw, sources, images }));
        }
      })();
      // Resolves with the validated resource card (or null) once the stream
      // has been fully consumed; chatController persists/streams it.
      out.resource = resourcePromise;
      return out;
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
    const { resourceRaw, text: prose } = extractResourceBlock(aiContent);
    const resource = buildResource({ raw: resourceRaw, sources, images });
    return {
      content: grounding
        ? await groundAnswer({ ...grounding, text: prose })
        : sanitizeLinks(prose, allowedUrls),
      metadata: {
        provider: env.aiProvider,
        model: data.model || requestModel,
        usage: data.usage,
        ...(sources.length > 0 ? { webSearch: { used: true, sources } } : {}),
        ...(resource ? { resource } : {}),
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

export const analyzeImageBuffer = async ({ imageBuffer, mimetype = '', filename = '', question }) => {
  if (!env.hasAiKey) throw new Error(openRouter.AI_KEY_MISSING_MESSAGE);
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    const err = new Error('Image data is missing. Please upload a valid image.');
    err.statusCode = 400;
    throw err;
  }

  const base64 = imageBuffer.toString('base64');
  const mimeType = normalizeImageMime(mimetype, filename);

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

export const transcribeAudio = async (audioBuffer, audioFilename = 'recording.webm') => {
  let formData;
  try {
    if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
      throw new Error('Audio data is missing');
    }
    formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), audioFilename || 'recording.webm');
    formData.append('model', env.aiTranscribeModel);
  } catch (err) {
    console.error('[STT] Could not read audio data:', err?.message || err);
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