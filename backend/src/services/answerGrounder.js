// ---------------------------------------------------------------------------
// Evidence-grounding layer.
//
// The numbered web-search results are the SOURCE OF TRUTH for a web-searched
// answer. This module enforces that after the answer model has written its
// draft: every claim is checked against the retrieved evidence and anything
// the evidence does not support is removed or explicitly marked as
// unconfirmed by the sources.
//
// Nothing here knows about any topic, entity, language or question type - it
// only compares a draft against the evidence that was actually retrieved.
//
//   groundAnswer()        -> non-streaming path (one check for the draft)
//   createGroundedStream() -> streaming path (the draft is checked block by
//                             block as it is produced, in order, so the same
//                             rules apply to streamed and non-streamed output)
//
// Structural link/citation rules (URLs and [n] markers must come from the
// evidence) are applied before AND after the check, so a fabricated link can
// never reach the user even if the checking call itself fails.
// ---------------------------------------------------------------------------

import env from '../config/env.js';
import * as openRouter from './providers/openRouterProvider.js';
import { buildUrlAllowlist, normalizeUrlKey, sanitizeLinks } from './webSearchService.js';

const VERIFY_TIMEOUT_MS = 30000;

const VERIFY_SYSTEM = `You are a strict fact checker for a web-searched answer.

You receive three things: a user's question, the NUMBERED web search results that were retrieved for it (this is the only evidence that exists), and a draft answer.

Go claim by claim. For every factual claim, ask: does the evidence actually state this? Keep what it states and delete everything else, then return the answer.

Rules:
- DELETION IS THE DEFAULT. Delete an unsupported sentence completely. Never leave an unsupported claim in the text and merely append a disclaimer to it.
- Only when the user's question is about the missing information may you add ONE short sentence saying the available search results do not confirm it. That sentence must not repeat the unsupported detail: refer to it generically ("the cost", "the release date", "the vendor", "the figures") and never with the specific number, date, name, version or feature the evidence does not support.
- Never present an unsupported entity, figure, date, version, feature, statistic, report, benchmark, regulation, organization or person as real - not even in a sentence that ends by calling it unconfirmed.
- If you are unsure whether the evidence supports a claim, treat the claim as unsupported.
- Never add a fact, number, date, name, entity, feature, statistic, report, benchmark, regulation, example, URL or citation that is not in the evidence. Never complete missing information from your own knowledge, and never make an answer look more complete than the evidence allows.
- A source mentioning an entity does NOT support other properties of that entity. Only what a source actually states is supported.
- Citations are structure, not claims: never remove, move or renumber a marker [n] that is attached to a supported claim, and never keep a marker the evidence does not back.
- Links are structure too: never delete or rewrite a URL that appears in the evidence results - keep it wherever the draft used it, even when you delete an unsupported claim sitting next to it. Delete only URLs that are not in the evidence.
- Keep everything the evidence does support exactly as written: same language, tone, structure, order, headings, lists, tables, links, formatting and length. Do not shorten supported content.
- For "latest / current / today / now" claims: support comes only from the evidence; if the evidence does not cover the requested time, say the search results do not confirm it.
- If the evidence's sources disagree, keep both claims with their attribution instead of silently choosing one.
- In table rows, list items, comparisons and recommendations, every value must be supported by the evidence - delete unsupported cells, rows, items or points.
- Delete filler attributions ("according to reports", "industry sources say", "experts say", "widely used", "latest report") unless the evidence explicitly supports them.
- Delete any sentence that presents a hypothetical or illustrative example as a real, current fact.
- Delete sentences that talk about knowledge cutoffs, not having real-time access, or training data.
- Never modify anything inside a code block; return code blocks byte-identical.
- Keep a citation like [2] only if source 2 exists in the evidence; never invent new citation numbers.
- If the answer contains nothing unsupported, return it unchanged.
- Never add notes about your own checking process (for example "the segment only contained...", "as supported by the evidence", "all evidence sources confirm") and never restate content that already appears elsewhere in the answer.
- Return ONLY the answer text: no explanations, no preamble, no surrounding code fences.`;

// ---------------------------------------------------------------------------
// No-evidence check.
//
// Used when a search ran but produced NO usable results. There is no web
// evidence to ground against, so the draft is NOT compared to search results.
// Instead it keeps what is safe to say without evidence (application/self
// context and stable general knowledge) and deletes unverifiable current or
// external specifics. It never forces a search-failure disclaimer: one is
// added only when the user's question genuinely needs current/external facts.
// ---------------------------------------------------------------------------
const VERIFY_SYSTEM_NO_EVIDENCE = `You are a strict fact checker. A web search was performed for this answer but returned NO usable results, so there is NO web evidence available.

You receive the user's question and a draft answer.

Keep only what is safe to say without web evidence, and remove anything that would be an unverifiable current or external claim.

KEEP (do not delete):
- Anything about the assistant/application itself: its identity, purpose, abilities, features, how it works, and its creator when the segment states it. This is trusted self-knowledge.
- Stable, well-established general knowledge that does not depend on the current date, live prices, versions, breaking news or any other time-sensitive fact.
- Conversational content: greetings, offers of help, questions to the user, tone, structure, headings, lists, formatting and length.

DELETE:
- Any current or external factual claim that would need fresh verification: news, current events, live prices, versions, releases, statistics, product specifications, laws, rankings, or any specific present-day fact.
- Every URL, link, domain and [n] citation (none may remain).
- Any fabricated source, report, organization, person or quote.
- Any sentence that presents an unverifiable specific current detail as fact.

Rules:
- Never invent a fact, number, date, name, source, URL or citation.
- Do not repeat an unsupported specific detail when explaining it away; refer to it generically.
- Do NOT add a search-failure disclaimer merely because the search was empty. Only when the user's question genuinely requires current or external information does the draft answer with unverifiable specifics: in that case delete those specifics and replace them with ONE short sentence saying the available search results do not confirm it.
- If the answer is fully answerable from the assistant's own context or from stable knowledge, return it unchanged.
- Never add notes about your own checking process and never restate content that already appears elsewhere in the answer.
- Return ONLY the answer text: no explanations, no preamble, no surrounding code fences.`;

const normalizeEvidence = (evidence) => String(evidence || '').trim();

// --------------------------------------------------------------------------
// One checking call. Returns null when it cannot be performed (no key, bad
// response, error) so callers fall back to the structurally sanitized draft.
// --------------------------------------------------------------------------
const askChecker = async ({ question, evidence, segment, noEvidence = false }) => {
  if (!env.hasAiKey) return null;
  const userContent = noEvidence
    ? `QUESTION:\n${question}\n\nWEB SEARCH: no usable results were found for this question.\n\nDRAFT SEGMENT:\n${segment}`
    : `QUESTION:\n${question}\n\nEVIDENCE (web search results):\n${evidence}\n\nDRAFT SEGMENT:\n${segment}`;
  try {
    const res = await openRouter.chatCompletions({
      model: env.aiModel,
      messages: [
        { role: 'system', content: noEvidence ? VERIFY_SYSTEM_NO_EVIDENCE : VERIFY_SYSTEM },
        { role: 'user', content: userContent },
      ],
      stream: false,
      max_tokens: 4096,
      temperature: 0,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    const raw = await res.text().catch(() => '');
    const data = JSON.parse(raw);
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch (err) {
    console.warn('[Grounding] evidence check failed:', err?.message || err);
    return null;
  }
};

// --------------------------------------------------------------------------
// Structural rules that are always enforced, with or without the checker:
//   - only URLs that literally came from the search results may remain
//   - only [n] markers that exist in the evidence may remain
// --------------------------------------------------------------------------
export const sanitizeCitations = (text, sourceCount) => {
  const count = Number(sourceCount);
  if (!Number.isFinite(count) || count <= 0) {
    // No evidence: a numeric marker cannot refer to anything.
    return String(text || '').replace(/\[\d{1,4}\](?!\()/g, '');
  }
  return String(text || '').replace(/\[(\d{1,4})\](?!\()/g, (match, n) => {
    const idx = Number(n);
    return idx >= 1 && idx <= count ? match : '';
  });
};

export const sanitizeGroundedText = (text, { allowedUrls, sourceCount } = {}) => {
  const withoutBadLinks = sanitizeLinks(text, allowedUrls);
  return sanitizeCitations(withoutBadLinks, sourceCount);
};

const buildGuards = (sources) => {
  const list = Array.isArray(sources) ? sources : [];
  return { allowedUrls: buildUrlAllowlist(list), sourceCount: list.length };
};

// Evidence URLs (from the search results) that literally appear in a piece of
// text, de-duplicated and in order of first appearance. Used to make sure the
// checker can never silently drop a link the draft had already cited.
const EVIDENCE_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const evidenceUrlsIn = (text, allowedUrls) => {
  if (!(allowedUrls instanceof Set)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').match(EVIDENCE_URL_RE) || []) {
    const clean = raw.replace(/[)\].,;:!?'"]+$/, '');
    const key = normalizeUrlKey(clean);
    if (key && allowedUrls.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
};

// Re-attach evidence links the checker removed, so a source the draft cited can
// never disappear from the answer. Links are structure, not claims: they are
// restored as the source's own title link (or bare URL) and never fabricated.
const restoreEvidenceLinks = (text, urls, sources) => {
  if (!urls.length) return text;
  const list = Array.isArray(sources) ? sources : [];
  const links = urls.map((url) => {
    const key = normalizeUrlKey(url);
    const match = list.find((s) => normalizeUrlKey(s?.url) === key);
    const title = match?.title ? String(match.title).replace(/[\[\]\r\n]+/g, ' ').trim() : '';
    return title ? `[${title}](${url})` : url;
  });
  const body = String(text || '').trimEnd();
  return `${body}${body ? '\n\n' : ''}Sources: ${links.join(' · ')}`;
};

// --------------------------------------------------------------------------
// Non-streaming path: check the whole draft once.
// `checker` is injectable so verification scripts can drive the pipeline
// deterministically; production calls always use the real evidence check.
// --------------------------------------------------------------------------
export const groundAnswer = async ({ question = '', evidence = '', sources = [], text = '', checker = null }) => {
  const guards = buildGuards(sources);
  // No evidence (no search ran): nothing to ground against, so the draft is
  // returned untouched - link and citation policy then belongs to the caller.
  if (!normalizeEvidence(evidence)) return String(text || '');
  // A search that ran but returned no usable results has no web evidence: the
  // draft is checked with the no-evidence rules (keep application/stable
  // knowledge, drop unverifiable current specifics) instead of the strict
  // evidence rules, so a valid self/general answer is never wiped out.
  const noEvidence = !Array.isArray(sources) || sources.length === 0;
  const prepared = sanitizeGroundedText(text, guards);
  if (!prepared.trim()) return prepared;

  const verify = typeof checker === 'function' ? checker : askChecker;
  const checked = await verify({ question, evidence: normalizeEvidence(evidence), segment: prepared, noEvidence });
  const final = checked ? sanitizeGroundedText(checked, guards) : prepared;

  // Guarantee link integrity: any evidence URL the draft already cited must
  // still be present after grounding. Prompt rules alone are not reliable, so
  // this is enforced structurally.
  const before = evidenceUrlsIn(prepared, guards.allowedUrls);
  if (!before.length) return final;
  const afterKeys = new Set(evidenceUrlsIn(final, guards.allowedUrls).map(normalizeUrlKey));
  const missing = before.filter((url) => !afterKeys.has(normalizeUrlKey(url)));
  return missing.length ? restoreEvidenceLinks(final, missing, sources) : final;
};

// --------------------------------------------------------------------------
// Streaming path.
//
// The COMPLETE draft is grounded ONCE - through the exact same groundAnswer()
// used by the non-streaming path - before a single character is emitted. This
// is what keeps the streamed and non-streamed answers equivalent.
//
// It also fixes the previous integration bug: the old version called the
// evidence checker once PER PARAGRAPH, so every call rewrote/expanded its own
// paragraph from the full evidence. The segments then stacked up into a
// duplicated answer ("Paris is the capital..." repeated), with the checker's
// own notes (for example "...as supported by all evidence sources provided")
// leaking into the user-visible text. Grounding the whole draft in one pass
// makes that impossible: the checker edits one complete answer instead of
// regenerating each fragment.
//
// When no search ran there is no evidence to ground against, so the raw stream
// is still passed through untouched (token-by-token, unchanged).
// --------------------------------------------------------------------------
const HEARTBEAT_MS = 15000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createGroundedStream = ({ question = '', evidence = '', sources = [], checker = null }, rawStream) => {
  const evidenceText = normalizeEvidence(evidence);
  // No evidence (no search ran): pass the raw stream through untouched.
  if (!evidenceText) return rawStream;

  return (async function* () {
    // The complete draft is buffered before anything is shown, so while the
    // model generates and the checker runs the client would otherwise see no
    // bytes from the moment the sources event arrived. Emit an empty heartbeat
    // every HEARTBEAT_MS: the client ignores empty content but it resets its
    // stall watchdog, so a long answer is never aborted mid-grounding.
    let draft = '';
    let last = Date.now();
    for await (const chunk of rawStream) {
      draft += String(chunk ?? '');
      if (Date.now() - last >= HEARTBEAT_MS) { last = Date.now(); yield ''; }
    }

    // Ground the whole draft in one pass, still heartbeating while it runs.
    let grounded;
    let settled = false;
    const job = groundAnswer({ question, evidence: evidenceText, sources, text: draft, checker })
      .then((value) => { grounded = value; settled = true; })
      .catch((err) => { settled = true; throw err; });
    job.catch(() => {});
    while (!settled) {
      const winner = await Promise.race([
        job.then(() => 'done', () => 'done'),
        sleep(HEARTBEAT_MS).then(() => 'tick'),
      ]);
      if (winner === 'tick') yield '';
    }
    await job;
    if (grounded) yield grounded;
  })();
};
