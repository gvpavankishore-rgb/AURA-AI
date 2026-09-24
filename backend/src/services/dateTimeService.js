import env from '../config/env.js';

// Server-side current-date/time handling. Explicit time/date questions are
// answered from the server clock at request time (never from the LLM's
// training data), and timezone requests are resolved against a curated
// city/region -> IANA timezone map. Unknown placed-timezone requests fall
// back to the app default timezone with an honest explanatory note.

const TIME_DATE_PATTERNS = [
  /^(present|current|local|exact|today'?s)?\s*(present|current|local|exact)\s+(time|date)\b/i,
  /\bwhat\s+time\s+is\s+it\b/i,
  /\bwhat('s| is)\s+the\s+(present|current|local|exact)?\s*time\b/i,
  /\bwhat('s| is)\s+the\s+(present|current|local|exact|today'?s?)?\s*(date|day)\b(?=\s|today|now|,|$)/i,
  /\btoday'?s?\s+date\b/i,
  /\bwhat\s+date\s+is\s+it\b/i,
  /\bwhat\s+day\s+is\s+(it|today)\b/i,
  /\bcurrent\s+(date\s+and\s+time|time\s+and\s+date|date|time|local\s+time)\b/i,
  /\b(date|time)\s+and\s+(date|time)\b/i,
  /\b(present|current|today'?s?)\s+(local\s+)?(time|date)\b/i,
  /\b(time|date)\s+(right\s+)?now\b/i,
  /\bcurrent\s+(utc|gmt)\s+time\b/i,
  /\btime\s+(in|at|for)\s+[a-z][a-z.\-' ]{0,28}\b/i,
  /\bindian\s+standard\s+time\b/i,
  /\bwhat\s+is\s+the\s+(time|date)\b/i,
];

const LOCATION_PREP = /\b(?:in|at|for)\s+((?:[A-Za-z][A-Za-z.'-]*\s*){1,6})\s*[?!.,]*\s*$/;

const STOP_WORDS = new Set([
  'today', 'todays', 'today\'s', 'now', 'right', 'please', 'the', 'a', 'an', 'my', 'me',
  'is', 'are', 'it', 'you', 'your', 'what', 'that', 'this', 'and', 'or', 'of', 'to',
  'there', 'here', 'local', 'exact', 'current', 'present', 'time', 'date', 'today\'s',
  'standard', 'day', 'zone', 'timezone', 'utc', 'gmt', 'ist', 'at', 'in', 'for', 'ask',
]);

// Curated location -> IANA timezone map. Deliberately small and conservative:
// an unknown place never gets a guess, it falls back to the app default.
const PLACE_TO_TZ = {
  // India (task requirement: Asia/Kolkata)
  india: 'Asia/Kolkata', hyderabad: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata', chennai: 'Asia/Kolkata', delhi: 'Asia/Kolkata',
  'new delhi': 'Asia/Kolkata', mumbai: 'Asia/Kolkata', pune: 'Asia/Kolkata',
  kolkata: 'Asia/Kolkata', jaipur: 'Asia/Kolkata', ahmedabad: 'Asia/Kolkata',
  lucknow: 'Asia/Kolkata', visakhapatnam: 'Asia/Kolkata', vizag: 'Asia/Kolkata',
  'indian standard time': 'Asia/Kolkata', ist: 'Asia/Kolkata',
  srilanka: 'Asia/Colombo', 'sri lanka': 'Asia/Colombo', colombo: 'Asia/Colombo',
  nepal: 'Asia/Kathmandu', kathmandu: 'Asia/Kathmandu', pakistan: 'Asia/Karachi',
  karachi: 'Asia/Karachi', lahore: 'Asia/Karachi', bangladesh: 'Asia/Dhaka', dhaka: 'Asia/Dhaka',
  // United States
  'new york': 'America/New_York', nyc: 'America/New_York', 'los angeles': 'America/Los_Angeles',
  la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', chicago: 'America/Chicago',
  houston: 'America/Chicago', dallas: 'America/Chicago', austin: 'America/Chicago',
  seattle: 'America/Los_Angeles', boston: 'America/New_York', miami: 'America/New_York',
  'washington dc': 'America/New_York', washington: 'America/New_York', phoenix: 'America/Phoenix',
  denver: 'America/Denver', atlanta: 'America/New_York', detroit: 'America/Detroit',
  usa: 'America/New_York', 'united states': 'America/New_York', america: 'America/New_York',
  // Canada
  canada: 'America/Toronto', toronto: 'America/Toronto', vancouver: 'America/Vancouver',
  montreal: 'America/Toronto', ottawa: 'America/Toronto',
  // UK / Europe
  london: 'Europe/London', manchester: 'Europe/London', birmingham: 'Europe/London',
  edinburgh: 'Europe/London', uk: 'Europe/London', england: 'Europe/London',
  'united kingdom': 'Europe/London', 'great britain': 'Europe/London',
  paris: 'Europe/Paris', france: 'Europe/Paris', berlin: 'Europe/Berlin',
  'frankfurt': 'Europe/Berlin', germany: 'Europe/Berlin', rome: 'Europe/Rome',
  italy: 'Europe/Rome', milan: 'Europe/Rome', madrid: 'Europe/Madrid', spain: 'Europe/Madrid',
  barcelona: 'Europe/Madrid', lisbon: 'Europe/Lisbon', portugal: 'Europe/Lisbon',
  amsterdam: 'Europe/Amsterdam', netherlands: 'Europe/Amsterdam', brussels: 'Europe/Brussels',
  zurich: 'Europe/Zurich', geneva: 'Europe/Zurich', switzerland: 'Europe/Zurich',
  vienna: 'Europe/Vienna', vienna: 'Europe/Vienna', warsaw: 'Europe/Warsaw', poland: 'Europe/Warsaw',
  prague: 'Europe/Prague', budapest: 'Europe/Budapest', stockholm: 'Europe/Stockholm',
  oslo: 'Europe/Oslo', copenhagen: 'Europe/Copenhagen', helsinki: 'Europe/Helsinki',
  dublin: 'Europe/Dublin', ireland: 'Europe/Dublin', athens: 'Europe/Athens', greece: 'Europe/Athens',
  moscow: 'Europe/Moscow', russia: 'Europe/Moscow', istanbul: 'Europe/Istanbul', turkey: 'Europe/Istanbul',
  // Middle East
  dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', uae: 'Asia/Dubai', doha: 'Asia/Qatar',
  qatar: 'Asia/Qatar', riyadh: 'Asia/Riyadh', 'saudi arabia': 'Asia/Riyadh', jeddah: 'Asia/Riyadh',
  tehran: 'Asia/Tehran', israel: 'Asia/Jerusalem', jerusalem: 'Asia/Jerusalem', 'tel aviv': 'Asia/Jerusalem',
  // Asia-Pacific
  tokyo: 'Asia/Tokyo', japan: 'Asia/Tokyo', osaka: 'Asia/Tokyo', seoul: 'Asia/Seoul',
  'south korea': 'Asia/Seoul', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai',
  shenzhen: 'Asia/Shanghai', china: 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong',
  singapore: 'Asia/Singapore', bangkok: 'Asia/Bangkok', thailand: 'Asia/Bangkok',
  jakarta: 'Asia/Jakarta', indonesia: 'Asia/Jakarta', 'kuala lumpur': 'Asia/Kuala_Lumpur',
  manila: 'Asia/Manila', philippines: 'Asia/Manila', taipei: 'Asia/Taipei', taiwan: 'Asia/Taipei',
  kathmandu: 'Asia/Kathmandu',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', perth: 'Australia/Perth',
  brisbane: 'Australia/Brisbane', adelaide: 'Australia/Adelaide', australia: 'Australia/Sydney',
  auckland: 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland', wellington: 'Pacific/Auckland',
  // Africa / Latin America
  cairo: 'Africa/Cairo', egypt: 'Africa/Cairo', lagos: 'Africa/Lagos', nigeria: 'Africa/Lagos',
  nairobi: 'Africa/Nairobi', 'south africa': 'Africa/Johannesburg', johannesburg: 'Africa/Johannesburg',
  'cape town': 'Africa/Johannesburg', 'sao paulo': 'America/Sao_Paulo', 'rio de janeiro': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires', 'mexico city': 'America/Mexico_City',
  // Coordinated / shorthand
  utc: 'UTC', gmt: 'GMT', utc: 'UTC', 'greenwich mean time': 'UTC',
};

const cleanupToken = (t) => {
  const cleaned = String(t || '').replace(/^['"(]+|['")\.,;:!?]+$/g, '');
  const tokens = String(cleaned).split(/\s+/).filter(Boolean);
  const kept = [];
  for (const token of tokens) {
    if (!STOP_WORDS.has(token.toLowerCase())) kept.push(token);
  }
  return kept.join(' ').trim();
};

const detectKind = (text) => {
  const hasTime = /\btime\b/.test(text) || /\bIST\b/.test(text);
  const hasDate = /\bdate\b/.test(text) || /\btoday'?s?\b/.test(text) || /\bday\s+is\s+it\b/.test(text);
  if (hasDate && hasTime) return 'both';
  if (hasDate) return 'date';
  return 'time';
};

export const detectCurrentDateTimeIntent = (text = '') => {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return { requested: false };

  const matched = TIME_DATE_PATTERNS.some((re) => re.test(t));
  if (!matched) return { requested: false };

  let location = null;
  const prep = t.match(LOCATION_PREP);
  if (prep) {
    const cleaned = cleanupToken(prep[1]);
    if (cleaned && !prep[1].toLowerCase().match(/^(right\s+now|right|now|there|here|utc|gmt)$/)) {
      location = cleaned.toLowerCase();
    }
  }
  // "What time is it in New York?" — match "in New York" within the question.
  if (!location) {
    const inner = t.match(/\b(?:in|at|for)\s+((?:[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,4}))\s*[?!.,]*$/);
    if (inner) {
      const cleaned = inner[1].trim();
      if (cleaned) location = cleaned.toLowerCase();
    }
  }

  if (!location && /\btime\s+in\b/.test(t)) {
    const m = t.match(/\btime\s+in\s+([a-z][a-z.\-' ]{0,28})/i);
    if (m) location = cleanupToken(m[1]).toLowerCase();
  }

  return { requested: true, kind: detectKind(t), location, utcHint: /\b(utc|gmt)\b/i.test(t) };
};

const ACRONYM_PLACES = new Set(['ist', 'uk', 'usa', 'uae', 'nyc', 'la', 'utc', 'gmt']);

const titleCase = (text = '') => {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  if (ACRONYM_PLACES.has(key)) return key.toUpperCase();
  return raw
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
};

export const resolveTimezone = (location = null) => {
  if (location) {
    const key = String(location).trim().toLowerCase().replace(/\s+/g, ' ');
    if (PLACE_TO_TZ[key]) return { timezone: PLACE_TO_TZ[key], label: key };
    // Trailing-region fallbacks: e.g. "united states of america" -> USA.
    if (/united\s+states/.test(key) || /^usa\b/.test(key)) return { timezone: 'America/New_York', label: key };
    if (/india/.test(key)) return { timezone: 'Asia/Kolkata', label: key };
    if (/uk|united\s+kingdom|britain|england|scotland|wales/.test(key)) return { timezone: 'Europe/London', label: key };
  }
  return null;
};

export const resolveDefaultTimezone = (user = null) => {
  const fromUser = user && user.timezone ? String(user.timezone).trim() : '';
  if (fromUser) return fromUser;
  return env.defaultTimezone;
};

const format = (now, opts) => {
  try {
    return new Intl.DateTimeFormat('en-US', opts).format(now);
  } catch {
    return null;
  }
};

export const formatNowInTimezone = ({ now = new Date(), timezone = 'Asia/Kolkata', kind = 'both' }) => {
  const dateOpts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const timeOpts = { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' };
  if (kind === 'date') return format(now, { ...dateOpts, timeZone: timezone });
  if (kind === 'time') return format(now, { ...timeOpts, timeZone: timezone });
  return format(now, { ...dateOpts, ...timeOpts, timeZone: timezone });
};

// Returns null when the message is NOT an explicit date/time question;
// otherwise { content, metadata } to be returned as a static assistant reply.
export const getCurrentDateTimeResponse = (content, user = null) => {
  const clean = String(content || '').trim();
  const part = clean.split(/\s*/)[0] || '';
  void part;
  const intent = detectCurrentDateTimeIntent(clean);
  if (!intent.requested) return null;

  const now = new Date();
  const requestedLocation = intent.location ? intent.location.trim() : '';
  const resolved = intent.location ? resolveTimezone(intent.location) : null;

  const useUtc = Boolean(intent.utcHint || (intent.location && /\b(utc|gmt)\b/i.test(intent.location)));
  const timezone = resolved ? resolved.timezone : useUtc ? 'UTC' : resolveDefaultTimezone(user);
  const known = Boolean(resolved) || useUtc || !intent.location;

  const value = formatNowInTimezone({ now, timezone, kind: intent.kind });
  if (!value) return null;

  const parts = [];
  const place = resolved ? titleCase(resolved.label) : intent.location ? titleCase(intent.location) : null;
  if (intent.kind === 'date') {
    parts.push(place ? `Today's date in ${place} is ${value}.` : `Today's date is ${value}.`);
  } else if (intent.kind === 'time') {
    parts.push(place ? `The current time in ${place} is ${value}.` : `The current time is ${value}.`);
  } else {
    parts.push(place ? `The current date and time in ${place} is ${value}.` : `The current date and time is ${value}.`);
  }
  if (!known) {
    parts.push(`I couldn't map "${intent.location}" to a timezone, so I used the default timezone ${timezone} instead.`);
  } else if (!intent.location) {
    parts.push(`UTC: ${format(now, { timezone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`);
  }
  parts.push('(Server clock at the time of your request.)');

  const metadata = {
    currentDateTime: {
      used: true,
      timezone,
      location: place || null,
      at: now.toISOString(),
    },
  };

  return { content: parts.join('\n\n'), metadata };
};