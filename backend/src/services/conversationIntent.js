// Generic conversation-intent classifier.
//
// Decides whether a user message is a purely social / ritual message - a
// greeting, farewell, thanks, pleasantry or emoji-only ping - that carries no
// information to look up. Such messages skip the universal web-search stage
// entirely (no query, no sources, no citations, no resource card) and get a
// brief conversational reply instead.
//
// There is deliberately NO list of literal questions here and NO
// string-equality against the user's text. The decision is made from the
// SHAPE of the message: the text is normalized, split into segments on
// separators/conjunctions, and every segment must either match a small-talk
// phrase pattern or consist exclusively of words from a small social
// vocabulary. Any segment containing a content word - a topic, a request
// verb, a bare question word (what/who/where/when/why/how) - fails the
// check and the whole message falls through to the universal web-search flow.
//
// The default is therefore "informational": a false social on a real
// question would hide the web from the user, while a false informational on
// a greeting only costs an unnecessary search. Bare question words are kept
// out of the vocabulary so contextual follow-ups like "how?" and identity
// probes keep their existing search behaviour.

// Words that only ever frame a social/ritual message. Content-bearing words
// (topics, request verbs such as give/tell/find/explain, question words)
// are intentionally absent: they force the message to the web-search flow.
const SOCIAL_WORDS = new Set([
  // greetings / farewells
  'hi', 'hey', 'hello', 'hiya', 'howdy', 'yo', 'greetings', 'sup',
  'bye', 'goodbye', 'morning', 'afternoon', 'evening', 'night', 'day',
  // thanks / appreciation
  'thanks', 'thank', 'thx', 'ty', 'appreciate', 'appreciated', 'grateful',
  // pleasantries / acknowledgements
  'ok', 'okay', 'cool', 'nice', 'great', 'awesome', 'wonderful', 'fantastic',
  'perfect', 'excellent', 'superb', 'brilliant', 'lovely', 'sweet', 'good',
  'wow', 'hm', 'hmm', 'mhm', 'yeah', 'yep', 'yup', 'nope', 'right', 'sure',
  'fine', 'cheers', 'congrats', 'congratulations', 'welcome', 'sorry',
  'excuse', 'pardon', 'please', 'well', 'help',
  // farewells / care
  'later', 'soon', 'take', 'care', 'have', 'talk', 'see', 'everything',
  // vocatives & pronouns that only frame a social message
  'you', 'your', 'ya', 'u', 'there', 'all', 'everyone', 'folks', 'guys',
  'team', 'friend', 'friends', 'dear', 'sir', 'madam', 'buddy', 'chat',
  // framing particles that carry no information on their own
  'a', 'an', 'the', 'so', 'much', 'very', 'lot', 'lots', 'too', 'it', 'my', 'me',
  'for', 'to', 'again', 'now',
]);

// Anchored small-talk patterns, applied per segment after normalization
// (lowercased, curly apostrophes folded, emoji removed). These cover the
// question-shaped social greetings that would otherwise contain bare
// question words.
const SOCIAL_PATTERNS = [
  /^how(?:'s|s| is| are|'re) (?:it|you|u|things|everything|life)(?: (?:doing|going|been|today|now|lately))?$/,
  /^how (?:are|is) (?:you|u|things|everything)(?: (?:doing|going|today|now|lately))?$/,
  /^how have (?:you|u) been$/,
  /^how do you do$/,
  /^how(?:'s|s| is| are|'re) (?:your|ur) (?:day|life|week|morning|evening)(?: (?:been|going))?$/,
  /^(?:what|whats)(?:'s|s| is) (?:up|new|happening|good|going on)$/,
  /^are (?:you|u) (?:ok|okay|good|well|fine|alright|there|free|awake)(?: (?:today|now))?$/,
  /^(?:nice|good|great|lovely) (?:to |meeting |seeing )?(?:meet|see)(?:ing)? (?:you|ya|u)$/,
  /^(?:nice|good) (?:talking|chatting) (?:to |with )?(?:you|ya|u)$/,
  /^long time no see$/,
];

const MAX_RAW_LENGTH = 600;
const MAX_WORDS = 50;

const normalize = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\uFE0F\u200D\u20E3]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const splitSegments = (text) =>
  text
    .split(/\s*[,;.\n]\s*|\s+(?:and|&)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

const isSocialSegment = (segment) => {
  const wordsOnly = segment
    .replace(/^\p{P}+|\p{P}+$/gu, '')
    .trim();
  // A segment that is only punctuation residue ("!!") carries no request.
  if (!wordsOnly) return true;
  if (SOCIAL_PATTERNS.some((re) => re.test(wordsOnly))) return true;
  const words = wordsOnly.split(/\s+/);
  return words.every((w) => SOCIAL_WORDS.has(w));
};

// True when `text` is purely social/ritual and must skip the web-search
// stage. Empty input is NOT conversational: the existing empty-message path
// (attachment-only / no_query) keeps handling it unchanged.
export const isConversationalMessage = (text) => {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > MAX_RAW_LENGTH) return false;

  const normalized = normalize(raw);
  // Emoji-only / pictograph-only pings are social by definition.
  if (!normalized) return true;
  if (normalized.split(' ').length > MAX_WORDS) return false;

  const segments = splitSegments(normalized);
  if (!segments.length) return true;
  return segments.every(isSocialSegment);
};

// Words that frame a question (interrogatives, auxiliaries, determiners and
// prepositions) without naming the subject it is about. They let us measure
// how much real content a question carries.
const FRAMING_WORDS = new Set([
  'what', 'whats', 'who', 'whom', 'whose', 'which', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'about', 'into', 'over',
  'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
]);

// True when a message carries an unmistakable information request that small
// talk cannot reasonably explain: it contains a URL, or it is a question that
// names at least two content words (the subject it is asking about).
//
// This is a deterministic safety net for the model layer: a casually phrased
// but genuinely factual question ("Hey, what are the latest AI tools?") must
// keep its search even if a classifier mistakes the greeting for small talk.
export const isConfidentInformation = (text) => {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (/https?:\/\//i.test(raw)) return true;
  if (!/[?？]\s*$/.test(raw)) return false;

  const words = normalize(raw)
    .split(' ')
    .map((w) => w.replace(/[^\p{L}\p{N}']/gu, ''))
    .filter(Boolean);
  const content = words.filter(
    (w) => w.length >= 3 && !SOCIAL_WORDS.has(w) && !FRAMING_WORDS.has(w)
  );
  return content.length >= 2;
};

export default isConversationalMessage;
