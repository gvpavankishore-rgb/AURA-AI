// ---------------------------------------------------------------------------
// Dynamic rich resource card.
//
// When a web-search answer contains a single directly useful resource (a
// trailer, video, official website, documentation page, repository, product
// page, article, map, booking page, download ...), the answer model appends a
// machine-readable block to its draft:
//
//   ::RESOURCE
//   {"type":"...","title":"...","primaryLink":"...","images":[...],"metadata":[...]}
//   ::END
//
// This module:
//   - pulls that block out of the text (streaming and non-streaming) so the
//     user never sees the raw JSON,
//   - and builds the card object ONLY from values that are literally present
//     in the search evidence: URLs must match a URL the search returned, and
//     every title/description/metadata value must be supported by the evidence.
//
// There is no list of movies, genres, actors, sites or questions here: the
// type is chosen by the model, and everything is validated against whatever
// the search happened to return for the current query.
// ---------------------------------------------------------------------------

import { buildUrlAllowlist, normalizeUrlKey } from './webSearchService.js';

export const RESOURCE_START = '::RESOURCE';
export const RESOURCE_END = '::END';

// Generic kinds of direct resource a card can represent.
export const RESOURCE_TYPES = [
  'video',
  'movie_trailer',
  'website',
  'documentation',
  'repository',
  'product',
  'article',
  'map',
  'booking',
  'download',
  'other',
];

// Generic fallback labels per kind (UI text, never a fact about the resource).
const TYPE_LABELS = {
  video: 'Watch video',
  movie_trailer: 'Watch trailer',
  website: 'Open website',
  documentation: 'Open documentation',
  repository: 'Open repository',
  product: 'View product',
  article: 'Read article',
  map: 'Open map',
  booking: 'Open booking',
  download: 'Download',
  other: 'Open link',
};

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 360;
const MAX_LABEL = 40;
const MAX_VALUE = 140;
const MAX_METADATA = 6;
const MAX_IMAGES = 4;
const MAX_EVIDENCE = 3;

const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const lower = (value) => normalize(value).toLowerCase();

// Strip formatting an LLM may wrap around the JSON, then parse.
const safeJson = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '')
    .replace(/^```[a-zA-Z0-9]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const cleanText = (value, max) => normalize(value).slice(0, max);

// Structural grounding for one value: it must be traceable to the evidence.
// Exact phrase first; otherwise at least 70% of its significant tokens (all of
// them when there are only a couple) must appear. Fail-closed: when in doubt,
// the value is treated as unsupported and the field is dropped.
export const supportedText = (value, evidenceLower) => {
  const v = lower(value);
  if (!v) return false;
  if (evidenceLower.includes(v)) return true;
  const tokens = v.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (tokens.length < 2) return false;
  const present = tokens.filter((t) => evidenceLower.includes(t)).length;
  return present >= Math.ceil(tokens.length * 0.7);
};

// ---------------------------------------------------------------------------
// Pull the ::RESOURCE block out of a complete answer.
// ---------------------------------------------------------------------------
const collapse = (text) => String(text)
  .replace(/```[a-zA-Z0-9]*[ \t]*\n?[ \t]*```/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const extractResourceBlock = (text) => {
  const src = String(text || '');
  const start = src.indexOf(RESOURCE_START);
  if (start === -1) return { resourceRaw: null, text: src };
  const end = src.indexOf(RESOURCE_END, start + RESOURCE_START.length);
  // Strip every complete block (plus any incomplete trailing attempt) so a
  // model that emits more than one block can never leak a raw marker to prose.
  const prose = src.replace(new RegExp(`${RESOURCE_START}[\\s\\S]*?${RESOURCE_END}`, 'g'), '');
  const tail = prose.indexOf(RESOURCE_START);
  const clean = collapse(tail === -1 ? prose : prose.slice(0, tail));
  if (end === -1) {
    // Incomplete block: drop the attempt rather than leak half-written JSON.
    return { resourceRaw: null, text: clean };
  }
  const resourceRaw = src.slice(start + RESOURCE_START.length, end);
  return { resourceRaw, text: clean };
};

// Longest suffix of `text` that is a prefix of `marker` (so a marker split
// across stream chunks is never emitted as prose).
const holdLength = (text, marker) => {
  const max = Math.min(text.length, marker.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (text.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// Streaming twin of extractResourceBlock: yields the prose and fills `sink`
// with the raw block text once the block closes. The block is never yielded.
// ---------------------------------------------------------------------------
export const captureResourceStream = (rawStream, sink = {}) => {
  let pending = '';
  let raw = null;

  return (async function* () {
    try {
      for await (const chunk of rawStream) {
        if (typeof chunk !== 'string' || !chunk) continue;
        pending += chunk;
        while (true) {
          if (raw === null) {
            const start = pending.indexOf(RESOURCE_START);
            if (start !== -1) {
              if (start > 0) yield pending.slice(0, start);
              raw = '';
              pending = pending.slice(start + RESOURCE_START.length);
              continue;
            }
            const hold = holdLength(pending, RESOURCE_START);
            const emit = pending.slice(0, pending.length - hold);
            pending = pending.slice(pending.length - hold);
            if (emit) yield emit;
            break;
          }
          const end = pending.indexOf(RESOURCE_END);
          if (end !== -1) {
            sink.raw = (sink.raw || '') + raw + pending.slice(0, end);
            raw = null;
            pending = pending.slice(end + RESOURCE_END.length);
            continue;
          }
          // Hold back a suffix that could be the start of a split end marker
          // (e.g. "::E" + "ND") so the block is never mistaken for incomplete.
          const holdEnd = holdLength(pending, RESOURCE_END);
          raw += pending.slice(0, pending.length - holdEnd);
          pending = pending.slice(pending.length - holdEnd);
          break;
        }
      }
      if (raw !== null) {
        sink.incomplete = true;
      } else if (pending) {
        yield pending;
      }
    } finally {
      sink.done = true;
    }
  })();
};

// ---------------------------------------------------------------------------
// Validate a raw block against the evidence and build the card payload.
// Returns null when there is nothing trustworthy to show.
// ---------------------------------------------------------------------------
export const buildResource = ({ raw, sources = [], images = [] }) => {
  const parsed = safeJson(raw);
  if (!parsed) return null;

  const sourceList = (Array.isArray(sources) ? sources : []).filter((s) => s && (s.url || s.title));
  const evidenceLower = lower(sourceList.map((s) => `${s.title || ''} ${s.content || ''}`).join(' \n '));
  if (!evidenceLower) return null;

  const urlAllow = buildUrlAllowlist(sourceList);
  const imageAllow = buildUrlAllowlist((Array.isArray(images) ? images : []).map((url) => ({ url })));

  const pickAllowed = (value, allow) => {
    const key = normalizeUrlKey(value);
    if (!key || !allow.has(key)) return null;
    const cleaned = String(value).trim();
    return cleaned || null;
  };

  // A card without a real, search-provided link is not a resource card.
  const primaryLink = pickAllowed(parsed.primaryLink, urlAllow);
  if (!primaryLink) return null;

  const title = cleanText(parsed.title, MAX_TITLE);
  if (!title || !supportedText(title, evidenceLower)) return null;

  const rawType = lower(parsed.type).replace(/\s+/g, '_');
  const type = RESOURCE_TYPES.includes(rawType) ? rawType : 'other';

  const description = cleanText(parsed.description, MAX_DESCRIPTION);
  // A description the evidence cannot support is dropped, never shown.
  const safeDescription = description && supportedText(description, evidenceLower) ? description : null;

  const cardImages = (Array.isArray(parsed.images) ? parsed.images : [])
    .map((url) => pickAllowed(url, imageAllow))
    .filter(Boolean)
    .slice(0, MAX_IMAGES);

  const metadata = (Array.isArray(parsed.metadata) ? parsed.metadata : [])
    .map((entry) => (entry && typeof entry === 'object'
      ? { label: cleanText(entry.label, MAX_LABEL), value: cleanText(entry.value, MAX_VALUE) }
      : null))
    .filter((entry) => entry
      && entry.label
      && entry.value
      && !/https?:|www\./i.test(entry.value)
      && supportedText(entry.value, evidenceLower))
    .slice(0, MAX_METADATA);

  const matched = sourceList.find((s) => normalizeUrlKey(s.url) === normalizeUrlKey(primaryLink)) || null;
  const source = matched
    ? { title: cleanText(matched.title, MAX_TITLE) || primaryLink, url: String(matched.url).trim() }
    : null;

  const evidence = sourceList
    .filter((s) => s.url && supportedText(title, lower(`${s.title || ''} ${s.content || ''}`)))
    .slice(0, MAX_EVIDENCE)
    .map((s) => ({ title: cleanText(s.title, MAX_TITLE) || String(s.url).trim(), url: String(s.url).trim() }));

  const requestedLabel = cleanText(parsed.primaryLinkLabel, MAX_LABEL);
  const primaryLinkLabel = requestedLabel && !/https?:|www\./i.test(requestedLabel)
    ? requestedLabel
    : (TYPE_LABELS[type] || TYPE_LABELS.other);

  return {
    type,
    title,
    description: safeDescription,
    images: cardImages,
    primaryLink,
    primaryLinkLabel,
    metadata,
    source,
    evidence,
  };
};
