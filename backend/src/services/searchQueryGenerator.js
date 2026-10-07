// Generic, topic-agnostic search-query generation for AURA's universal
// web-search pipeline.
//
// IMPORTANT: this module contains NO question classifier, NO topic/keyword
// lists, NO whitelists or blacklists and NO predefined questions. Every user
// message goes through the exact same path here. The only transformations are
// language-level cleanups that apply to any sentence in any domain:
//
//   1. strip conversational filler ("do you know ...", "please tell me ...")
//   2. strip interrogative / grammatical stop words (what, is, the, ...)
//   3. drop duplicate words, cap the length
//
// Negations ("not", "never", "no") are deliberately preserved so the query
// keeps the user's actual meaning.

const FILLER_PATTERNS = [
  /^\s*(?:hey|hi|hello|ok|okay|sure|thanks|thank\s+you)\b[:,!\s]*/i,
  /\b(?:do|does|did|can|could|would|will|shall|is|are)\s+(?:you|u)\s+(?:please\s+)?(?:know|tell|help|share|give|find|check|confirm|look\s+up)\b/gi,
  /\b(?:do|does|did)\s+(?:anyone|someone|somebody)\s+know\b/gi,
  /\b(?:can|could|would|will|shall)\s+(?:you|u)\s+(?:please\s+)?(?:tell|help|share|give|find|search|look)\b/gi,
  /\b(?:please|kindly)\s+(?:tell|help|share|give|find|search|look|show|explain|answer)\b/gi,
  /\b(?:please|kindly)\b/gi,
  /\btell\s+me\b/gi,
  /\blet\s+me\s+know\b/gi,
  /\bi\s+(?:want|need|would\s+like|was\s+hoping|am\s+hoping|'m\s+hoping)\s+to\s+know\b/gi,
  /\bi\s+(?:am\s+|'m\s+|was\s+|'m\s+)?looking\s+(?:for|to\s+know)\b/gi,
  /\bwhat\s+do\s+you\s+know\s+about\b/gi,
  /\b(?:by\s+the\s+way|btw)\b/gi,
];

// Purely grammatical words. Removing them leaves the informational core of
// the sentence, which is what search engines match best.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in',
  'on', 'at', 'for', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'have', 'has',
  'had', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might',
  'must', 'i', 'me', 'my', 'we', 'our', 'us', 'you', 'your', 'he', 'she',
  'it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'please', 'tell', 'know', 'about', 'let', 'like', 'want', 'need', 'get',
  'got', 'go', 'going', 'much', 'many', 'some', 'any', 'all', 'very', 'just',
  'really', 'actually', 'explain', 'define', 'there', 'here', 'thing', 'things',
]);

const MAX_QUERY_CHARS = 150;

// userQuestion -> searchQuery. Works for any question, including ones the
// developer has never seen.
export const buildSearchQuery = (text = '') => {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  // 1. conversational filler out
  let q = raw.replace(/[?!.]+$/g, '').trim();
  for (const re of FILLER_PATTERNS) q = q.replace(re, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  if (!q) q = raw.replace(/[?!.]+$/g, '').trim();

  // 2. grammatical stop words out, duplicates out, order preserved
  const kept = [];
  const seen = new Set();
  for (const token of q.split(/\s+/)) {
    const bare = token.replace(/^['"([{]+|['")\].,;:!?]+$/g, '');
    if (!bare) continue;
    const lower = bare.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    kept.push(bare);
  }

  const built = kept.join(' ').trim().slice(0, MAX_QUERY_CHARS).trim();
  // Fall back to the filler-stripped question if cleaning removed everything.
  return built || q.slice(0, MAX_QUERY_CHARS).trim();
};
