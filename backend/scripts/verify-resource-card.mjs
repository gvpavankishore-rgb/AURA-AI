// Dynamic verification for AURA's rich resource card.
//
//   node scripts/verify-resource-card.mjs
//   SKIP_LIVE=1 node scripts/verify-resource-card.mjs   (deterministic-only)
//
// Proves the resource card is entirely search-driven and evidence-validated,
// with no topic, title, actor, site or URL hardcoded anywhere:
//
//   [0]  a ::RESOURCE block never leaks into visible prose (stream + non-stream)
//   [1]  incomplete blocks are dropped, not half-shown
//   [2]  the block is captured exactly out of a stream (marker split across chunks)
//   [3]  a link that search did not return kills the card (fabricated URL)
//   [4]  a fabricated video URL kills the card
//   [5]  an unsupported title kills the card; unsupported metadata is dropped
//   [6]  fabricated image URLs are dropped; only search images survive
//   [7]  a card with no valid images still renders (empty images)
//   [8]  unknown/absent type -> "other"; URL text never lands in a label/value
//   [9]  a fully valid card keeps source + evidence, capped
//   [10] arbitrary generated domains: each card link must be a search URL
//   [11] no hardcoded topics/URLs in the service layer (token scan)
//   [12] end-to-end: a real search produces a validated card and clean prose
//   [13] end-to-end: non-search answers produce no card
//   [14] contextual follow-up resolves the earlier subject and stays validated
//   [15] streaming vs non-streaming agree on the card contract
//   [16] a normal informational question yields no resource block

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  RESOURCE_START, RESOURCE_END, RESOURCE_TYPES,
  extractResourceBlock, captureResourceStream, buildResource,
} from '../src/services/resourceCard.js';
import { buildUrlAllowlist, normalizeUrlKey } from '../src/services/webSearchService.js';
import { runWebSearchStage } from '../src/controllers/chatController.js';
import { processMessage } from '../src/services/aiService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Live sections call the real search + model. Set SKIP_LIVE=1 for a fast,
// deterministic-only pass (used while iterating).
const LIVE = process.env.SKIP_LIVE !== '1';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`FAIL   ${name}${detail ? ` :: ${detail}` : ''}`); }
};
const urlsIn = (s) => String(s || '').match(/https?:\/\/[^\s<>"'`)\]]+/g) || [];
const key = (u) => normalizeUrlKey(String(u).replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, ''));
const collect = async (gen) => {
  let out = '';
  for await (const chunk of gen) out += String(chunk);
  return out;
};
const asChunks = (text, size = 7) => (async function* () {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
})();

// ---------------------------------------------------------------------------
// Arbitrary fixtures: a completely fictional product on made-up domains.
// ---------------------------------------------------------------------------
const SOURCES = [
  {
    title: 'Nimbus Tracker 3 release notes',
    url: 'https://nimbus-tracker.example/releases/3',
    published: '2026-06-02',
    content: 'Nimbus Tracker 3 adds offline maps and a route planner. The app is available for Windows and macOS.',
  },
  {
    title: 'Nimbus Tracker downloads',
    url: 'https://nimbus-tracker.example/downloads',
    content: 'Download Nimbus Tracker 3 for Windows and macOS. Version 3.0 was published in June 2026 and weighs about 240 megabytes.',
  },
];
const IMAGES = [
  'https://cdn.nimbus-tracker.example/screens/hero.png',
  'https://cdn.nimbus-tracker.example/screens/route.png',
];
const FAKE_DOMAIN = 'not-a-real-signup.test';
const FAKE_CDN = 'https://totally-fake-cdn.test/banner.png';

const goodBlock = (overrides = {}) => JSON.stringify({
  type: 'download',
  title: 'Nimbus Tracker 3',
  description: 'Adds offline maps and a route planner.',
  primaryLink: 'https://nimbus-tracker.example/downloads',
  primaryLinkLabel: 'Download',
  images: IMAGES,
  metadata: [
    { label: 'Platform', value: 'Windows and macOS' },
    { label: 'Version', value: '3.0' },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
console.log('\n[0] the ::RESOURCE block never leaks into visible prose');
const prose = 'Nimbus Tracker 3 adds offline maps and a route planner [1].';
const draft = `${prose}\n\n${RESOURCE_START}\n${goodBlock()}\n${RESOURCE_END}`;
const extracted = extractResourceBlock(draft);
check('non-stream: block removed from prose', !extracted.text.includes(RESOURCE_START) && !extracted.text.includes(RESOURCE_END), extracted.text);
check('non-stream: prose survives', extracted.text.includes('offline maps and a route planner'), extracted.text);
check('non-stream: raw block captured', !!extracted.resourceRaw && extracted.resourceRaw.includes('nimbus-tracker.example/downloads'), extracted.resourceRaw);

const streamedText = await collect(captureResourceStream(asChunks(draft), {}));
check('streaming: block never yielded', !streamedText.includes(RESOURCE_START) && !streamedText.includes(RESOURCE_END) && !streamedText.includes('primaryLink'), streamedText);
check('streaming: prose survives', streamedText.includes('offline maps and a route planner'), streamedText);

// ---------------------------------------------------------------------------
console.log('\n[1] incomplete blocks are dropped, not half-shown');
const incomplete = `${prose}\n${RESOURCE_START}\n{"type":"download","title":"Nimbus`;
const incExtract = extractResourceBlock(incomplete);
check('non-stream: partial block dropped', incExtract.resourceRaw === null && !incExtract.text.includes(RESOURCE_START), JSON.stringify(incExtract));
const incSink = {};
const incStream = await collect(captureResourceStream(asChunks(incomplete), incSink));
check('streaming: partial block not yielded', !incStream.includes(RESOURCE_START) && !incStream.includes('"type"'), incStream);
check('streaming: partial block flagged incomplete', incSink.incomplete === true && incSink.raw == null, JSON.stringify(incSink));

// ---------------------------------------------------------------------------
console.log('\n[2] the block is captured exactly out of a stream (split markers)');
const splitSink = {};
const splitStream = await collect(captureResourceStream(asChunks(draft, 3), splitSink));
const rebuilt = buildResource({ raw: splitSink.raw, sources: SOURCES, images: IMAGES });
check('split stream: prose clean', !splitStream.includes(RESOURCE_START) && splitStream.includes('offline maps'), splitStream);
check('split stream: raw block exactly recovered', !!splitSink.raw && JSON.parse(splitSink.raw).primaryLink === 'https://nimbus-tracker.example/downloads', splitSink.raw);
check('split stream: rebuilt card matches non-stream card', JSON.stringify(rebuilt) === JSON.stringify(buildResource({ raw: extracted.resourceRaw, sources: SOURCES, images: IMAGES })), JSON.stringify(rebuilt));

// ---------------------------------------------------------------------------
console.log('\n[3] a link search did not return kills the card');
check('fabricated primaryLink -> null', buildResource({ raw: goodBlock({ primaryLink: `https://${FAKE_DOMAIN}/get` }), sources: SOURCES, images: IMAGES }) === null);
check('real primaryLink -> card', !!buildResource({ raw: goodBlock(), sources: SOURCES, images: IMAGES }));

// ---------------------------------------------------------------------------
console.log('\n[4] a fabricated video URL kills the card');
check('fabricated video URL -> null', buildResource({ raw: goodBlock({ type: 'video', primaryLink: 'https://www.youtube.com/watch?v=FAKEfakeFAKE' }), sources: SOURCES, images: IMAGES }) === null);

// ---------------------------------------------------------------------------
console.log('\n[5] unsupported title kills the card; unsupported metadata is dropped');
check('unsupported title -> null', buildResource({ raw: goodBlock({ title: 'Zephyr Quantum Widget Pro' }), sources: SOURCES, images: IMAGES }) === null);
const metaCard = buildResource({
  raw: goodBlock({
    metadata: [
      { label: 'Platform', value: 'Windows and macOS' },
      { label: 'Fabricated spec', value: 'runs on cold fusion and teleports files' },
      { label: 'Version', value: '3.0' },
      '"ignored": true',
    ],
  }),
  sources: SOURCES,
  images: IMAGES,
});
check('supported metadata kept', metaCard && metaCard.metadata.some((m) => m.value === 'Windows and macOS'), JSON.stringify(metaCard?.metadata));
check('unsupported metadata dropped', metaCard && !metaCard.metadata.some((m) => /cold fusion|teleports/i.test(m.value)), JSON.stringify(metaCard?.metadata));

// ---------------------------------------------------------------------------
console.log('\n[6] fabricated image URLs are dropped; only search images survive');
const imgCard = buildResource({ raw: goodBlock({ images: [FAKE_CDN, IMAGES[0], 'not-a-url'] }), sources: SOURCES, images: IMAGES });
check('only search image survives', imgCard && imgCard.images.length === 1 && imgCard.images[0] === IMAGES[0], JSON.stringify(imgCard?.images));
check('fabricated image removed', imgCard && !imgCard.images.includes(FAKE_CDN), JSON.stringify(imgCard?.images));

// ---------------------------------------------------------------------------
console.log('\n[7] a card with no valid images still renders');
const noImgCard = buildResource({ raw: goodBlock({ images: [FAKE_CDN] }), sources: SOURCES, images: [] });
check('card survives without images', noImgCard && Array.isArray(noImgCard.images) && noImgCard.images.length === 0, JSON.stringify(noImgCard?.images));

// ---------------------------------------------------------------------------
console.log('\n[8] type coercion and URL-free labels/values');
const otherCard = buildResource({ raw: goodBlock({ type: 'teleportpad' }), sources: SOURCES, images: IMAGES });
check('unknown type -> "other"', otherCard && otherCard.type === 'other', otherCard?.type);
check('allowed types are generic', RESOURCE_TYPES.every((t) => typeof t === 'string' && t.length > 0));
const urlLabelCard = buildResource({ raw: goodBlock({ primaryLinkLabel: 'https://evil.test/x' }), sources: SOURCES, images: IMAGES });
check('URL in link label -> generic fallback', urlLabelCard && !urlsIn(urlLabelCard.primaryLinkLabel).length && urlLabelCard.primaryLinkLabel === 'Download', urlLabelCard?.primaryLinkLabel);
const urlMetaCard = buildResource({ raw: goodBlock({ metadata: [{ label: 'Site', value: 'https://evil.test/x' }] }), sources: SOURCES, images: IMAGES });
check('URL in metadata value -> dropped', urlMetaCard && !urlMetaCard.metadata.some((m) => /evil\.test/.test(m.value)), JSON.stringify(urlMetaCard?.metadata));

// ---------------------------------------------------------------------------
console.log('\n[9] a valid card keeps a capped source + evidence');
check('source points at the matched result', metaCard && metaCard.source && metaCard.source.url === 'https://nimbus-tracker.example/downloads', JSON.stringify(metaCard?.source));
check('evidence capped and search-only', metaCard && metaCard.evidence.length <= 3 && metaCard.evidence.every((e) => e.url.startsWith('https://nimbus-tracker.example/')), JSON.stringify(metaCard?.evidence));

// ---------------------------------------------------------------------------
console.log('\n[10] arbitrary generated domains: card link must be a search URL');
const dynamicFixtures = [
  { subject: 'Kestrel air quality sensor', domain: 'kestrel-air.example.net', path: '/aq-2', detail: 'reports particulate levels every sixty seconds' },
  { subject: 'Marlow chess clock', domain: 'marlow-clock.example.org', path: '/model-c', detail: 'offers Fischer increments and a quiet mode' },
  { subject: 'Tern hiking route', domain: 'tern-trails.example.info', path: '/coast-path', detail: 'covers ninety kilometres of coastal path' },
];
for (const f of dynamicFixtures) {
  const src = [{ title: f.subject, url: `https://${f.domain}${f.path}`, content: `${f.subject} ${f.detail}.` }];
  const allow = buildUrlAllowlist(src);
  const raw = JSON.stringify({
    type: 'website',
    title: f.subject,
    primaryLink: `https://${f.domain}${f.path}`,
    images: [],
    metadata: [],
  });
  const card = buildResource({ raw, sources: src, images: [] });
  check(`${f.domain}: real link accepted`, card && key(card.primaryLink) === key(`https://${f.domain}${f.path}`), JSON.stringify(card));
  check(`${f.domain}: allowed by search allowlist`, allow.has(key(card?.primaryLink)), key(card?.primaryLink));
  const fake = buildResource({ raw: JSON.stringify({ ...JSON.parse(raw), primaryLink: `https://${FAKE_DOMAIN}${f.path}` }), sources: src, images: [] });
  check(`${f.domain}: unrelated domain rejected`, fake === null);
}

// ---------------------------------------------------------------------------
console.log('\n[11] no hardcoded topics/URLs in the service layer (token scan)');
const servicesDir = path.resolve(__dirname, '../src/services');
const files = fs.readdirSync(servicesDir).filter((f) => f.endsWith('.js'));
const haystack = files.map((f) => fs.readFileSync(path.join(servicesDir, f), 'utf8').toLowerCase()).join('\n');
const forbidden = ['pawan', 'kalyan', 'paradise', 'they call him og', 'youtube.com/watch?v='];
for (const token of forbidden) {
  check(`no hardcoded "${token}" in services`, !haystack.includes(token));
}
check('resourceCard.js contains no topic list', !/telugu|tollywood|bollywood/i.test(fs.readFileSync(path.join(servicesDir, 'resourceCard.js'), 'utf8')));
check('services scanned', files.length >= 5, files.join(', '));

// ---------------------------------------------------------------------------
if (LIVE) {
  console.log('\n[12] end-to-end: a real search produces a validated card and clean prose');
  const liveStage = await runWebSearchStage('give me one telugu movie trailer', []);
  console.log(`   · stage=${liveStage.type} query=${JSON.stringify(liveStage.metadata?.webSearch?.query)} sources=${(liveStage.sources || []).length} images=${(liveStage.images || []).length}`);
  check('live: search ran with results', liveStage.type === 'search' && (liveStage.sources || []).length > 0, JSON.stringify(liveStage.metadata?.webSearch));
  const liveAllow = buildUrlAllowlist(liveStage.sources || []);
  const liveImages = liveStage.images || [];
  const liveCtx = { sources: liveStage.sources, images: liveImages, text: liveStage.contextText };
  const liveNon = await processMessage({ messages: [{ role: 'user', content: 'give me one telugu movie trailer' }], userContent: 'give me one telugu movie trailer', stream: false, webSearch: liveCtx });
  const liveNonText = String(liveNon?.content || '');
  check('live: non-stream prose has no block markers', !liveNonText.includes(RESOURCE_START) && !liveNonText.includes(RESOURCE_END), liveNonText.slice(0, 300));
  check('live: non-stream prose has no fabricated URLs', urlsIn(liveNonText).every((u) => liveAllow.has(key(u))), JSON.stringify(urlsIn(liveNonText)));
  const liveCard = liveNon?.metadata?.resource || null;
  check('live: card (if any) link came from the search', !liveCard || liveAllow.has(key(liveCard.primaryLink)), JSON.stringify(liveCard));
  check('live: card (if any) images came from the search', !liveCard || liveCard.images.every((u) => liveImages.some((i) => key(i) === key(u))), JSON.stringify(liveCard?.images));
  if (liveCard) console.log(`   · live card: type=${liveCard.type} title=${JSON.stringify(liveCard.title)} link=${liveCard.primaryLink}`);

  console.log('\n[13] end-to-end: non-search answers produce no card');
  const plain = await processMessage({ messages: [{ role: 'user', content: 'say hello' }], userContent: 'say hello', stream: false });
  check('plain answer has no resource', !plain?.metadata?.resource, JSON.stringify(plain?.metadata));
  check('plain answer has no block markers', !String(plain?.content || '').includes(RESOURCE_START), plain?.content);

  console.log('\n[14] contextual follow-up resolves the earlier subject and stays validated');
  const history = [
    { role: 'user', content: 'Tell me about the movie The Godfather (1972)' },
    { role: 'assistant', content: 'The Godfather is a 1972 crime film directed by Francis Ford Coppola.' },
  ];
  const followStage = await runWebSearchStage('give me the trailer', history);
  console.log(`   · follow-up stage=${followStage.type} query=${JSON.stringify(followStage.metadata?.webSearch?.query)}`);
  check('follow-up produced a search', followStage.type === 'search' && (followStage.sources || []).length > 0, JSON.stringify(followStage.metadata?.webSearch));
  check('follow-up query carries the earlier subject', /godfather/i.test(followStage.metadata?.webSearch?.query || ''), followStage.metadata?.webSearch?.query);
  const followMessages = [...history, { role: 'user', content: 'give me the trailer' }];
  const followOut = await processMessage({
    messages: followMessages,
    userContent: 'give me the trailer',
    stream: false,
    webSearch: { sources: followStage.sources, images: followStage.images || [], text: followStage.contextText },
  });
  const followText = String(followOut?.content || '');
  const followAllow = buildUrlAllowlist(followStage.sources || []);
  check('follow-up: prose has no block markers', !followText.includes(RESOURCE_START), followText.slice(0, 200));
  check('follow-up: no URLs outside the search results', urlsIn(followText).every((u) => followAllow.has(key(u))), JSON.stringify(urlsIn(followText)));
  const followCard = followOut?.metadata?.resource || null;
  check('follow-up: card (if any) link came from the search', !followCard || followAllow.has(key(followCard.primaryLink)), JSON.stringify(followCard));

  console.log('\n[15] streaming vs non-streaming agree on the card contract');
  const streamGen = await processMessage({ messages: [{ role: 'user', content: 'give me one telugu movie trailer' }], userContent: 'give me one telugu movie trailer', stream: true, webSearch: liveCtx });
  check('streaming: exposes a resource promise', streamGen && typeof streamGen.resource?.then === 'function');
  const streamText = await collect(streamGen);
  const streamCard = await streamGen.resource;
  check('streaming: prose has no block markers', !streamText.includes(RESOURCE_START) && !streamText.includes(RESOURCE_END), streamText.slice(0, 300));
  check('streaming: prose has no fabricated URLs', urlsIn(streamText).every((u) => liveAllow.has(key(u))), `${JSON.stringify(urlsIn(streamText))} :: ${streamText.slice(0, 400)}`);
  check('streaming: card (if any) link came from the search', !streamCard || liveAllow.has(key(streamCard.primaryLink)), JSON.stringify(streamCard));
  check('streaming: card (if any) images are search-only', !streamCard || streamCard.images.every((u) => liveImages.some((i) => key(i) === key(u))), JSON.stringify(streamCard?.images));
  check('streaming: resource promise resolves to card or null', streamCard === null || (typeof streamCard === 'object' && typeof streamCard.primaryLink === 'string'), JSON.stringify(streamCard));

  console.log('\n[16] a normal informational question yields no resource block');
  const infoStage = await runWebSearchStage('what is the tallest mountain in the world', []);
  const infoOut = await processMessage({
    messages: [{ role: 'user', content: 'what is the tallest mountain in the world' }],
    userContent: 'what is the tallest mountain in the world',
    stream: false,
    webSearch: { sources: infoStage.sources, images: infoStage.images || [], text: infoStage.contextText },
  });
  const infoText = String(infoOut?.content || '');
  check('informational: no block markers in prose', !infoText.includes(RESOURCE_START) && !infoText.includes(RESOURCE_END), infoText.slice(0, 200));
  check('informational: no resource card', !infoOut?.metadata?.resource, JSON.stringify(infoOut?.metadata?.resource));
  check('informational: answer is non-empty', infoText.trim().length > 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed${LIVE ? '' : ' (deterministic-only)'}`);
process.exit(fail > 0 ? 1 : 0);
