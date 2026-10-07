// ---------------------------------------------------------------------------
// Universal search planning.
//
//   ANY request -> resolve intent/subject from conversation -> query
//                -> web search -> relevance check -> answer material
//                -> (if nothing relevant) one refined search
//
// This module is the reusable "context-resolution layer" of the pipeline.
// It contains NO question list, NO topic/keyword/entity list, NO language
// rules and NO intent categories. Every decision is made at runtime from
// the conversation, the model's own reasoning, and what the search engine
// actually returned.
//
// Failure policy: whenever an auxiliary AI step is unavailable, the pipeline
// degrades to the previous deterministic behaviour instead of breaking -
// a plain query is built from the message, and whatever the search engine
// returned is kept for the answer model to weigh.
// ---------------------------------------------------------------------------

import env from '../config/env.js';
import * as openRouter from './providers/openRouterProvider.js';
import * as webSearchService from './webSearchService.js';
import { buildSearchQuery } from './searchQueryGenerator.js';

const PLANNER_TIMEOUT_MS = 20000;
const MAX_QUERY_CHARS = 150;
const HISTORY_MESSAGES = 8;
const HISTORY_CHARS = 400;
const FALLBACK_CONTEXT_TOKENS = 3;

const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// --------------------------------------------------------------------------
// Shared helper: one short, non-streaming completion. Returns null on any
// problem so callers can fall back. Never logs or exposes keys.
// --------------------------------------------------------------------------
const askAssistant = async ({ system, prompt, maxTokens = 300 }) => {
  if (!env.hasAiKey) return null;
  try {
    const res = await openRouter.chatCompletions({
      model: env.aiModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      stream: false,
      max_tokens: maxTokens,
      timeoutMs: PLANNER_TIMEOUT_MS,
    });
    const raw = await res.text().catch(() => '');
    const data = JSON.parse(raw);
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch (err) {
    console.warn('[SearchPlanner] auxiliary AI step failed:', err?.message || err);
    return null;
  }
};

const firstJsonObject = (text) => {
  const start = String(text || '').indexOf('{');
  const end = String(text || '').lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

const cleanQuery = (text) => {
  const line = normalize(String(text || '').split('\n')[0]).replace(/^['"`]+|['"`]+$/g, '');
  const bare = line.replace(/^[?!.]+/, '').replace(/[?!.]+$/, '').trim();
  return bare.slice(0, MAX_QUERY_CHARS).trim();
};

const countWords = (text) => (normalize(text) ? normalize(text).split(/\s+/).length : 0);

// --------------------------------------------------------------------------
// Conversation context (runtime data only - nothing is predefined here).
// The message that triggered this request is excluded so the resolver sees
// "conversation so far" + the latest message as separate inputs.
// --------------------------------------------------------------------------
const priorTurns = (history, latest) => (Array.isArray(history) ? history : []).filter((m) => {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
  if (m.role === 'user' && normalize(m.content) === latest) return false;
  return Boolean(normalize(m.content));
});

const formatTurns = (turns) => turns
  .slice(-HISTORY_MESSAGES)
  .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${normalize(m.content).slice(0, HISTORY_CHARS)}`)
  .join('\n');

const lastUserTurn = (turns) => {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'user') return normalize(turns[i].content);
  }
  return '';
};

// --------------------------------------------------------------------------
// Step 1 - context-aware query resolution.
//
// A short follow-up ("it", "the same one", "show me the link", ...) must not
// be searched literally: the query is rebuilt from the whole conversation so
// it carries the subject, the intent and any constraints the user stated.
// --------------------------------------------------------------------------
const QUERY_SYSTEM = `You convert a conversation into ONE web search query for a search engine.
Reply with ONLY the query text: no quotes, no code fences, no explanation, no trailing punctuation.

Rules:
- The latest user message may be short or may refer back to earlier messages. Resolve every reference using the conversation so the query expresses the COMPLETE meaning of what the user wants right now: the subject/entity involved, what exactly they want, and any constraints they gave (language, place, date, budget, format, and so on).
- A message that is addressed to the assistant itself (about "you"/"your"/"yourself", its identity, abilities, features, how it works, or who made it) is about the assistant application, NOT about any subject discussed earlier. Never attach a previously discussed topic to such a message.
- Never add a subject or topic the user did not ask about, and never replace the subject they asked about with a different one.
- Never answer the question yourself. Output only the query.
- Keep it to roughly 15 words or fewer.
- Write the query in the language of the user's request.`;

export const resolveSearchQuery = async ({ content, history = [] }) => {
  const latest = normalize(content);
  if (!latest) return '';

  const turns = priorTurns(history, latest);
  if (turns.length === 0) return buildSearchQuery(latest);

  const resolved = cleanQuery(await askAssistant({
    system: QUERY_SYSTEM,
    prompt: `Conversation so far:\n${formatTurns(turns)}\n\nLatest user message:\n${latest}\n\nSearch query:`,
  }));
  if (resolved) return resolved;

  // Deterministic fallback (no AI available): still context-aware - a short
  // message is combined with the previous subject instead of searched alone.
  const standalone = buildSearchQuery(latest);
  const priorUser = lastUserTurn(turns);
  if (priorUser && countWords(standalone) <= FALLBACK_CONTEXT_TOKENS) {
    return buildSearchQuery(`${priorUser} ${latest}`);
  }
  return standalone;
};

// --------------------------------------------------------------------------
// Step 2 - relevance of the retrieved results.
//
// Results are never assumed relevant: each one is checked against the
// subject, the intent and the context. Irrelevant look-alikes are dropped,
// and when nothing relevant came back a better query is proposed so the
// search can be repeated.
// --------------------------------------------------------------------------
const RELEVANCE_SYSTEM = `You check whether web search results match a user's request. You never answer the request yourself.

Reply with ONLY a JSON object of this shape:
{"relevant":[0,2],"refinedQuery":""}

Fields:
- "relevant": zero-based indices of the results from the numbered list that BOTH (a) concern the same subject/entity the user is asking about, and (b) actually help answer what the user asked, given the conversation context.
- Drop results about a different subject or about a similarly named but different subject, and results that do not serve the user's intent. When you are unsure, KEEP the result instead of dropping it.
- "refinedQuery": a short search query for the SAME subject and intent, written in the user's language, that would find better results. Provide it ONLY when fewer than two results are relevant. Otherwise use an empty string.
- If the list of results is empty, use an empty "relevant" array and always supply "refinedQuery".
- Never include URLs in your reply and never invent results.`;

export const evaluateResults = async ({ content = '', history = [], query = '', results = [] }) => {
  const list = Array.isArray(results) ? results : [];
  const numbered = list.length === 0
    ? '(no results were returned)'
    : list.map((r, i) => `${i}. ${normalize(r?.title).slice(0, 200) || '(untitled)'}${r?.published ? ` (${normalize(r.published).slice(0, 40)})` : ''}\n   ${normalize(r?.content).slice(0, 300)}`).join('\n');

  const raw = await askAssistant({
    system: RELEVANCE_SYSTEM,
    prompt: `Conversation so far:\n${formatTurns(priorTurns(history, normalize(content))) || '(none)'}\n\nUser request:\n${normalize(content)}\n\nQuery used:\n${normalize(query)}\n\nSearch results:\n${numbered}\n\nJSON:`,
    maxTokens: 400,
  });

  const parsed = firstJsonObject(raw);
  if (!parsed) {
    // No usable judgement - keep everything rather than throw results away.
    return { kept: list, refinedQuery: null, skipped: true };
  }

  const relevant = Array.isArray(parsed.relevant) ? parsed.relevant : [];
  const kept = relevant
    .filter((i) => Number.isInteger(i) && i >= 0 && i < list.length)
    .map((i) => list[i]);

  const refinedQuery = typeof parsed.refinedQuery === 'string' ? cleanQuery(parsed.refinedQuery) : '';
  return { kept, refinedQuery: refinedQuery || null, skipped: false };
};

// --------------------------------------------------------------------------
// Full plan: query -> search -> relevance -> (one) refinement.
// `search` is injectable so the flow can be exercised in tests.
// --------------------------------------------------------------------------
export const planSearch = async ({ content, history = [], search = webSearchService.searchWeb }) => {
  const latest = normalize(content);
  if (!latest) return { status: 'no_query', query: '' };

  const query = await resolveSearchQuery({ content: latest, history });
  if (!query) return { status: 'no_query', query: '' };

  let response;
  try {
    response = await search(query);
  } catch (err) {
    return { status: 'failed', query, error: err };
  }
  if (!response || response.enabled === false) return { status: 'disabled', query };

  let finalQuery = query;
  let results = Array.isArray(response.results) ? response.results : [];
  // Images that came back with the search that supplied the final sources.
  let images = Array.isArray(response.images) ? response.images : [];
  let evaluation = await evaluateResults({ content: latest, history, query, results });
  let kept = evaluation.kept;

  // The evaluator supplies a refined query exactly when fewer than two results
  // are relevant (including the empty-result case), so that is the moment to
  // search once more with a better query.
  if (kept.length < 2 && evaluation.refinedQuery) {
    try {
      const retry = await search(evaluation.refinedQuery);
      if (retry && retry.enabled !== false) {
        const retryResults = Array.isArray(retry.results) ? retry.results : [];
        const retryEvaluation = await evaluateResults({
          content: latest,
          history,
          query: evaluation.refinedQuery,
          results: retryResults,
        });
        if (retryEvaluation.kept.length > 0) {
          kept = retryEvaluation.kept;
          finalQuery = evaluation.refinedQuery;
          images = Array.isArray(retry.images) ? retry.images : [];
        }
        // Otherwise the first pass still holds the only relevant result(s).
      }
    } catch (err) {
      console.warn('[SearchPlanner] refined search failed:', err?.message || err);
    }
  }

  return {
    status: 'ok',
    query: finalQuery,
    refined: finalQuery !== query,
    sources: kept,
    images,
  };
};
