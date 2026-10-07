import env from '../config/env.js';

// Honest fallbacks. Used ONLY when the search system itself is
// disabled/failing - never as a substitute for a search that succeeded.
export const SEARCH_UNAVAILABLE_MESSAGE = "Live web search is temporarily unavailable, so I can't retrieve fresh web information to answer accurately right now. Please try again in a moment.";
export const SEARCH_NO_RESULTS_MESSAGE = "I couldn't find any useful web results for that question, so I can't reliably confirm the details. Please try again or rephrase the question.";
export const SEARCH_DISABLED_MESSAGE = "Live web search is not enabled on this server, so I can't retrieve fresh web information to answer accurately right now.";

// Injected as the model context when a search ran but returned nothing, so the
// model states that honestly instead of inventing an answer.
export const NO_RESULTS_CONTEXT = 'The web search ran successfully but returned NO relevant results for this query.';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 20000;
const MAX_RESULTS = 6;
const SNIPPET_MAX_CHARS = 400;
const MAX_CONTEXT_CHARS = 6000;

// Untrusted remote text -> safe prompt text. Strips control characters
// (which could otherwise smuggle prompt instructions across lines), zero-width
// characters and excessive whitespace.
const sanitizeText = (value, maxChars) => String(value || '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxChars);

// Only http(s) links are ever shown to the user or quoted to the model.
const sanitizeUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch { /* not a URL */ }
  return '';
};

// "Domain/site" of a result, shown alongside title + URL. Derived only from a
// URL that already exists in the retrieved results.
const domainOf = (value) => {
  try {
    return new URL(String(value || '')).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const throwFriendly = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Normalise a URL for allowlist comparison: strip trailing punctuation and
// slashes, lowercase. Shared with the resource-card layer so link and image
// membership are decided by exactly the same rule.
export const normalizeUrlKey = (url) => {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw
    .replace(/[)\].,;:!?'"]+$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
};

// Image URLs the search engine actually returned. Never constructed, never
// guessed: anything that doesn't parse as http(s) is dropped.
const MAX_IMAGES = 8;
const sanitizeImages = (list) => {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const url = sanitizeUrl(item);
    const key = normalizeUrlKey(url);
    if (!url || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
};

const isEnabled = () => Boolean(env.webSearch && env.webSearch.enabled);

// Search the web with the configured provider. Returns:
//   { enabled, provider, results: [{ title, url, content, score }] }
// NEVER returns or logs the API key. Throws a friendly error on failure so
// callers can decide how to degrade gracefully.
export const searchWeb = async (query) => {
  const provider = env.webSearch && env.webSearch.provider;
  if (!isEnabled()) {
    return { enabled: false, provider, results: [], generatedAt: null };
  }
  if (provider === 'tavily') return searchTavily(query);
  console.error(`[WebSearch] Unknown provider "${provider}" (set WEB_SEARCH_PROVIDER=tavily).`);
  throw throwFriendly(SEARCH_UNAVAILABLE_MESSAGE, 502);
};

const searchTavily = async (query) => {
  const apiKey = env.webSearch && env.webSearch.tavilyApiKey;
  if (!apiKey) {
    console.error('[WebSearch] WEB_SEARCH_ENABLED=true but TAVILY_API_KEY is not set in backend/.env.');
    throw throwFriendly(SEARCH_UNAVAILABLE_MESSAGE, 502);
  }

  const q = String(query || '').trim();
  if (!q) return { enabled: true, provider: 'tavily', results: [], generatedAt: new Date().toISOString() };

  console.log(`[WebSearch] tavily query: ${q.slice(0, 160)}`);

  let res;
  try {
    res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        max_results: MAX_RESULTS,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        include_images: true,
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || err?.message?.includes('aborted');
    console.error('[WebSearch] Tavily network error:', timedOut ? 'timeout' : (err?.cause?.message || err?.message || err));
    throw throwFriendly(timedOut ? SEARCH_UNAVAILABLE_MESSAGE : SEARCH_UNAVAILABLE_MESSAGE, timedOut ? 504 : 503);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    console.error(`[WebSearch] Tavily HTTP ${res.status}:`, raw.slice(0, 300) || '(no error body)');
    throw throwFriendly(SEARCH_UNAVAILABLE_MESSAGE, 502);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('[WebSearch] Tavily returned malformed JSON.');
    throw throwFriendly(SEARCH_UNAVAILABLE_MESSAGE, 502);
  }

  const results = (Array.isArray(data?.results) ? data.results : [])
    .filter((r) => r && (r.title || r.url))
    .map((r) => ({
      title: sanitizeText(r.title, 200),
      url: sanitizeUrl(r.url),
      domain: domainOf(sanitizeUrl(r.url)),
      content: sanitizeText(r.content || r.snippet, SNIPPET_MAX_CHARS),
      // Publication date when the provider supplies one ("... when available").
      published: sanitizeText(r.published_date || r.publishedDate || r.date, 40) || null,
      score: typeof r.score === 'number' ? r.score : 0,
    }))
    .filter((r) => r.title || r.url)
    .slice(0, MAX_RESULTS);

  return { enabled: true, provider: 'tavily', results, images: sanitizeImages(data?.images), generatedAt: new Date().toISOString() };
};

// Builds the "Web Search Results" block that is injected into the AI system
// prompt so the model answers from retrieved content instead of guessing.
//
// Search results are UNTRUSTED third-party text, so everything that goes into
// the prompt is sanitized first: control characters are stripped, whitespace is
// collapsed, only http(s) URLs survive, and the whole block is size-capped so
// a huge page can never blow up the prompt or the request.
export const buildSearchContext = (sources, images = []) => {
  const results = Array.isArray(sources) ? sources : [];
  if (results.length === 0) return '';
  const lines = [];
  let total = 0;
  for (let i = 0; i < results.length && total < MAX_CONTEXT_CHARS; i += 1) {
    const r = results[i] || {};
    const title = sanitizeText(r.title, 200);
    const url = sanitizeUrl(r.url);
    const content = sanitizeText(r.content, SNIPPET_MAX_CHARS);
    const published = sanitizeText(r.published, 40);
    const block = `${lines.length + 1}. ${title || '(untitled)'}${published ? ` (${published})` : ''}\n   URL: ${url || '(no url)'}\n   ${content || '(no snippet)'}`;
    if (total + block.length > MAX_CONTEXT_CHARS) {
      const remaining = Math.max(0, MAX_CONTEXT_CHARS - total - 1);
      if (remaining > 40) lines.push(block.slice(0, remaining) + '…');
      break;
    }
    lines.push(block);
    total += block.length + 2;
  }
  const context = lines.join('\n\n');
  // Images that came back with the search. They are the ONLY image URLs the
  // answer may reference (for the resource card); nothing is ever derived.
  const imageList = sanitizeImages(images);
  if (imageList.length === 0) return context;
  return `${context}\n\nImage URLs returned by the search (use one of these verbatim for a resource card image, or none):\n${imageList.map((u) => `- ${u}`).join('\n')}`;
};

// ---------------------------------------------------------------------------
// Link accuracy
//
// The model may only turn URLs into links when that exact URL came back from
// the search results. It never gets to invent, guess or construct one
// (including fake video IDs). Nothing here is topic-specific: the allowlist is
// built purely from whatever the search returned.
// ---------------------------------------------------------------------------

export const buildUrlAllowlist = (sources) => {
  const allowed = new Set();
  for (const s of Array.isArray(sources) ? sources : []) {
    const key = normalizeUrlKey(sanitizeUrl(s?.url));
    if (key) allowed.add(key);
  }
  return allowed;
};

// `allowedUrls` is null when no search ran (e.g. translate/document flows):
// those answers are left untouched. A search that returned zero results
// produces an empty set, so any link the model adds is de-linked.
export const sanitizeLinks = (text, allowedUrls) => {
  const src = String(text || '');
  if (!src || !(allowedUrls instanceof Set)) return src;
  const allowed = (url) => {
    const key = normalizeUrlKey(url);
    return Boolean(key) && allowedUrls.has(key);
  };

  let out = src.replace(/\[([^\]\n]*)\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/g, (m, label, url) => (allowed(url) ? m : label));
  out = out.replace(/https?:\/\/[^\s<>"'`]+/g, (url) => (allowed(url) ? url : ''));
  return out;
};

// Streaming wrapper: text is emitted chunk by chunk, but anything that could
// still turn into a link is held back for one round so a rejected link can be
// stripped before the user ever sees it (deltas often split right before a
// URL, or between `](` and the target).
// Suffix that could still grow into a URL: a scheme with or without `://`,
// or a partial scheme (`h`, `ht`, `htt`) because deltas can split anywhere.
const HOLDBACK_RE = /https?:\/\/\S*$|https?:?\/?$|htt$|ht$|h$/;
// Never hold more than this much back, so a stray unclosed `](` in a code
// block can not stall the rest of the answer.
const HOLD_LIMIT = 400;

const findHoldIndex = (text) => {
  let idx = text.search(HOLDBACK_RE);

  // An unclosed `[label](` construct: hold from its `[` so the whole link can
  // be accepted or de-linked in one piece once the target is known.
  const openBracket = text.lastIndexOf('[');
  if (openBracket !== -1 && text.indexOf(')', openBracket) === -1) {
    idx = idx === -1 ? openBracket : Math.min(idx, openBracket);
  } else if (idx > 0 && text[idx - 1] === '(' && text[idx - 2] === ']') {
    const open = text.lastIndexOf('[', idx - 2);
    if (open !== -1) idx = open;
  }

  if (idx === -1) return -1;
  if (text.length - idx > HOLD_LIMIT) return text.length - HOLD_LIMIT;
  return idx;
};

export const createLinkSanitizer = (allowedUrls) => {
  let pending = '';
  const filter = (chunk) => sanitizeLinks(chunk, allowedUrls);

  return {
    push(chunk) {
      pending += String(chunk || '');
      const holdIdx = findHoldIndex(pending);
      if (holdIdx === -1) {
        const out = filter(pending);
        pending = '';
        return out;
      }
      const out = filter(pending.slice(0, holdIdx));
      pending = pending.slice(holdIdx);
      return out;
    },
    flush() {
      const out = filter(pending);
      pending = '';
      return out;
    },
  };
};