import env from '../config/env.js';

export const SEARCH_UNAVAILABLE_MESSAGE = "Live web search is temporarily unavailable, so I can't reliably provide the requested current information.";
export const SEARCH_NO_RESULTS_MESSAGE = "I couldn't find any recent information about that from the web, so I can't reliably confirm the current details. Please try again or check the source directly.";
export const SEARCH_DISABLED_MESSAGE = "Live web search is not enabled on this server, so I can't check current information right now.";

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 20000;
const MAX_RESULTS = 6;
const SNIPPET_MAX_CHARS = 400;

const throwFriendly = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
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
      title: String(r.title || '').trim().slice(0, 200),
      url: String(r.url || '').trim(),
      content: String(r.content || r.snippet || '').trim().slice(0, SNIPPET_MAX_CHARS),
      score: typeof r.score === 'number' ? r.score : 0,
    }))
    .slice(0, MAX_RESULTS);

  return { enabled: true, provider: 'tavily', results, generatedAt: new Date().toISOString() };
};

// Builds the "Web Search Results" block that is injected into the AI system
// prompt so the model answers from retrieved content instead of guessing.
export const buildSearchContext = (sources) => {
  const results = Array.isArray(sources) ? sources : [];
  if (results.length === 0) return '';
  const lines = results.map((r, i) => {
    const title = String(r.title || '').trim();
    const url = String(r.url || '').trim();
    const content = String(r.content || '');
    return `${i + 1}. ${title}\n   URL: ${url || '(no url)'}\n   ${content || '(no snippet)'}`;
  });
  return lines.join('\n\n');
};