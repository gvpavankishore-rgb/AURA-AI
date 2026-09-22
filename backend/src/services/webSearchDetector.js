// Lightweight, dependency-free intent detector that decides when AURA should
// query the live web to answer a message instead of relying purely on the
// model. Normal "stable knowledge / coding" questions are never routed here.

const EXPLICIT_SEARCH_PATTERNS = [
  /\bsearch\s+(the\s+)?(web|internet|online)\b/i,
  /^\s*(search|google|look\s+up|find\s+for)\b/i,
  /\bsearch\s+the\s+web\s+for\b/i,
];

const WEATHER_PATTERNS = [
  /\bweather\s+(report|update|today|now|in|for|at|near|of)?\b/i,
  /\btoday'?s?\s+weather\b/i,
  /\bwhat('s| is|s the| are)?\s+the\s+weather\b/i,
  /\bforecast\b/i,
  /\btemperature\s+(today|now|right\s+now|in|for)\b/i,
  /\btemperature\s+(report|update)\b/i,
  // Rain / precipitation questions ("will it rain today", "is it raining in Chennai")
  /\bwill\s+it\s+rain\b/i,
  /\b(is\s+it|is\s+it\s+going\s+to)\s+rain(ing|y)?\b/i,
  /\brain\b(?=.*\b(today|now|tonight|tomorrow|afternoon|evening|morning|weekend)\b)/i,
  /\brain\s+in\b/i,
  /\brain\s+chance\b/i,
];

const NEWS_PATTERNS = [
  /\bnews\b/i,
  /\bheadlines?\b/i,
  /\bbreaking\s+news\b/i,
];

const RECENCY_PATTERNS = [
  /\b(latest|recent|current|breaking|live|real-?time|up\s*[- ]?to\s*[- ]?date|updated|fresh|hot)\b/i,
  /\btoday'?s?\b/i,
  /\byesterday'?s?\b/i,
  /\bwhat\s+happened\s+today\b/i,
];

const MARKET_PATTERNS = [
  /\b(stock|stocks|share|shares|crypto|cryptocurrency|market|markets|gold|crude|oil|bitcoin|ethereum|ether|solana|dogecoin|nifty|sensex)\b/i,
];

// Nouns that become "current-information" requests when combined with a
// recency signal (e.g. "latest AI news", "current date and time").
const INFO_NOUNS = /\b(price|prices|rate|rates|value|values|score|scores|status|result|results|updates?|events?|information|info|data|date|time|day|news|headlines|weather|forecast|temperature|stocks?|shares?|crypto|bitcoin|market|elections?|polls?|release|releases|announcement|announcements)\b/i;

const REPORT_VERBS = /\b(happened|happening|going\s+on|announced|released|launched|changed|opened|closed|won|lost)\b/i;

const cleanupToken = (t) => t.replace(/^['"(]+|['")\.,;:!?]+$/g, '');

const LOCATION_STOP = new Set([
  'today', "today's", 'todays', 'now', 'right', 'tonight', 'currently', 'please', 'the', 'this', 'that',
  'weather', 'forecast', 'temperature', 'report', 'current', 'latest',
  'next', 'week', 'month', 'weekend', 'morning', 'afternoon', 'evening',
  'night', 'outside', 'here', 'tomorrow', 'yesterday', 'daily', 'hourly',
  'what', 'is', 'are', 'me', 'my', 'a', 'an', 'and', 'for', 'in', 'at',
  'on', 'of', 'tell', 'give', 'get', 'show', 'want', 'need', 'check',
]);

export const isWeatherRequest = (text = '') => {
  const t = String(text || '').trim();
  if (!t) return false;
  return WEATHER_PATTERNS.some((re) => re.test(t));
};

// Best-effort location extraction for weather requests. Never invents a
// location: returns null when no plausible place name is present.
export const extractLocation = (text = '') => {
  const t = String(text || '').trim();
  if (!t) return null;

  const candidates = [];

  // "weather in Hyderabad today" / "forecast for New York tomorrow"
  const match1 = t.match(/\b(?:weather|forecast|temperature)\s+(?:in|for|at|near|around|of)\s+((?:[A-Za-z][A-Za-z.'-]*\s*){1,5})/i);
  if (match1) candidates.push(match1[1]);

  // "what is the weather in Hyderabad today?" (capitalized place after a preposition)
  const match2 = t.match(/\b(?:in|for|at|near|around)\s+((?:[A-Z][a-zA-Z.'-]+\s*){1,3})/);
  if (match2) candidates.push(match2[1]);

  // "Hyderabad weather" / "what is Hyderabad weather today"
  const match3 = t.match(/\b((?:[A-Z][a-zA-Z.'-]+\s*){1,3})(?:weather|forecast|temperature|report)\b/);
  if (match3) candidates.push(match3[1]);

  for (const raw of candidates) {
    const tokens = String(raw || '').trim().split(/\s+/).map(cleanupToken).filter(Boolean);
    const kept = [];
    for (const token of tokens) {
      if (!token) continue;
      if (LOCATION_STOP.has(token.toLowerCase())) continue;
      kept.push(token);
    }
    const cleaned = kept.join(' ').trim();
    if (cleaned && /[\p{L}\p{N}]/u.test(cleaned)) return cleaned;
  }
  return null;
};

// Returns { needsSearch, weather, explicit, location }.
export const detectWebSearchIntent = (text = '') => {
  const t = String(text || '').trim();
  if (!t) return { needsSearch: false, weather: false, explicit: false, location: null };

  const hasExplicit = EXPLICIT_SEARCH_PATTERNS.some((re) => re.test(t));
  const isWeather = WEATHER_PATTERNS.some((re) => re.test(t));
  const isNews = NEWS_PATTERNS.some((re) => re.test(t));
  const hasRecency = RECENCY_PATTERNS.some((re) => re.test(t));
  const isMarket = MARKET_PATTERNS.some((re) => re.test(t));

  const asksWhatHappened = /what\s+happened\s+today/i.test(t);
  const asksWeatherHeading = /^\s*what[^?.!]*\bweather\b/i.test(t);
  const asksLatestHeading = /^\s*what('s| is| are)?\s+the\s+(latest|current|recent)\b/i.test(t);

  const needsSearch =
    hasExplicit ||
    isWeather ||
    asksWhatHappened ||
    asksWeatherHeading ||
    (isNews && (hasRecency || /^\s*top\s+news\b/i.test(t))) ||
    (hasRecency && INFO_NOUNS.test(t)) ||
    (hasRecency && REPORT_VERBS.test(t)) ||
    (isMarket && /\b(price|prices|rate|rates|value|values|current|latest|today'?s?|quote|quotes)\b/i.test(t));

  return {
    needsSearch,
    weather: isWeather,
    explicit: hasExplicit,
    location: isWeather ? extractLocation(t) : null,
  };
};