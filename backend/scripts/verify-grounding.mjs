// Dynamic verification for AURA's evidence-grounding layer.
//
//   node scripts/verify-grounding.mjs
//
// Proves the required guarantees end to end, with no topic-specific or
// keyword-specific rules anywhere: every assertion is structural (does the
// output still contain only facts, URLs, citations and code that came from
// the evidence?), and the arbitrary-domain fixtures in group [11] are generated
// from unrelated subjects on the fly.
//
//   [0]  real evidence URLs survive / fabricated URLs are removed
//   [1]  real YouTube URLs survive / fabricated video URLs are removed
//   [2]  invalid [n] citation markers are removed, valid ones survive
//   [3]  no-search / no-source behaviour
//   [4]  supported facts survive (live evidence check)
//   [5]  unsupported statistics, dates/versions, entities, features and
//        fabricated source names are removed (live evidence check)
//   [6]  unsupported table/list values are removed, supported ones survive
//   [7]  conflicting sources are preserved with attribution
//   [8]  insufficient evidence produces no hallucinated claims
//   [9]  code blocks remain byte-identical
//   [10] streaming and non-streaming give the same grounding/link guarantees
//   [11] contextual follow-up resolves the previous subject and stays grounded
//   [12] arbitrary domains/topics work with no topic-specific rules

import { groundAnswer, createGroundedStream, sanitizeCitations } from '../src/services/answerGrounder.js';
import { buildSearchContext, buildUrlAllowlist, NO_RESULTS_CONTEXT } from '../src/services/webSearchService.js';
import { runWebSearchStage } from '../src/controllers/chatController.js';
import { processMessage } from '../src/services/aiService.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`FAIL   ${name}${detail ? ` :: ${detail}` : ''}`); }
};

const lower = (s) => String(s || '').toLowerCase();
const hasText = (s, needle) => lower(s).includes(lower(needle));
// True when a token only appears inside a sentence that denies it (an honest
// "the search results do not confirm X" is not a hallucinated claim).
const assertsToken = (s, needle) => String(s || '')
  .split(/(?<=[.!?])\s+|\n+/)
  .filter((sentence) => lower(sentence).includes(lower(needle)))
  .some((sentence) => !/(not|no\b|cannot|can'?t|couldn'?t|unable|didn'?t|does not|do not|isn'?t|wasn'?t|nothing|insufficient|unconfirmed)/i.test(sentence));
const urlsIn = (s) => String(s || '').match(/https?:\/\/[^\s<>"'`]+/g) || [];
const markersIn = (s) => String(s || '').match(/\[\d{1,4}\]/g) || [];
const fenceInner = (s) => {
  const m = String(s || '').match(/```[a-zA-Z]*\r?\n([\s\S]*?)```/);
  return m ? m[1] : null;
};
// A checker that only proves the structural layer: it returns the segment as
// it was, so anything that disappears is a structural (non-model) rule.
const echoChecker = async ({ segment }) => segment;

const asChunks = (text, size = 9) => (async function* () {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
})();
const collect = async (gen) => {
  let out = '';
  for await (const chunk of gen) out += String(chunk);
  return out;
};

// ---------------------------------------------------------------------------
// Fixtures: arbitrary fictional subjects, arbitrary (non-real) domains.
// ---------------------------------------------------------------------------
const fixtureSources = [
  {
    title: 'Acme Ledger 4.2 release notes',
    url: 'https://acme-ledger.example/releases/4-2',
    published: '2026-05-12',
    content: 'Acme Ledger 4.2 adds CSV export and cuts initial sync time by 38 percent in tests run on standard laptops.',
  },
  {
    title: 'Acme Ledger pricing',
    url: 'https://acme-ledger.example/pricing',
    published: '2026-02-01',
    content: 'The Team plan costs 12 dollars per user per month and includes shared budgets.',
  },
  {
    title: 'Video walkthrough of Acme Ledger 4.2 CSV export',
    url: 'https://www.youtube.com/watch?v=aBc123XyZ_9',
    published: '2026-05-18',
    content: 'A video walkthrough of the CSV export workflow added in Acme Ledger 4.2.',
  },
];
const fixtureEvidence = buildSearchContext(fixtureSources);
const fixtureAllow = buildUrlAllowlist(fixtureSources);

const CODE_BLOCK = 'const sync = (rows) => rows.reduce((total, row) => total + row.length, 0);\n';

const DRAFT = [
  'Acme Ledger is made by Qwartz Labs; version 9.3 was released on 15 January 2027 and ships an offline mobile app with two-way sync.',
  '',
  '| Plan | Price | Extras |',
  '| --- | --- | --- |',
  '| Team | 12 dollars per user per month | shared budgets |',
  '| Enterprise | 999 dollars flat | SSO and audit logs |',
  '',
  'Acme Ledger 4.2 adds CSV export and cuts initial sync time by 38 percent in tests [1]. The Team plan costs 12 dollars per user per month [2].',
  '',
  'According to industry analyst firm Gartner IQ, adoption grew sharply [9]. See the [pricing page](https://acme-ledger.example/pricing) and this [video](https://www.youtube.com/watch?v=aBc123XyZ_9), plus [other notes](https://totally-not-real.test/pricing), more at https://totally-not-real.test/extra, the release notes at https://acme-ledger.example/releases/4-2 and a fake clip https://www.youtube.com/watch?v=FAKE123XYZ.',
  '',
  '```js',
  CODE_BLOCK.trimEnd(),
  '```',
].join('\n');

const UNSUPPORTED = ['97.4', '9.3', '2027', 'qwartz labs', 'offline mobile', 'gartner', 'totally-not-real.test', 'fake123xyz', '[9]'];

// ---------------------------------------------------------------------------
console.log('\n[0] real evidence URLs survive, fabricated URLs are removed');
const structural0 = await groundAnswer({
  question: 'what does it cost',
  evidence: fixtureEvidence,
  sources: fixtureSources,
  text: DRAFT,
  checker: echoChecker,
});
check('evidence URL kept as a link', structural0.includes('[pricing page](https://acme-ledger.example/pricing)'), structural0.slice(-300));
check('bare evidence URL kept', structural0.includes('https://acme-ledger.example/releases/4-2') || structural0.includes('https://acme-ledger.example/pricing'));
check('fabricated domain removed', !hasText(structural0, 'totally-not-real.test'), structural0.slice(-300));
check('fabricated URL never survives', !urlsIn(structural0).some((u) => hasText(u, 'totally-not-real')), JSON.stringify(urlsIn(structural0)));
check('every remaining URL comes from the evidence', urlsIn(structural0).every((u) => fixtureAllow.has(u.replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '').toLowerCase())), JSON.stringify(urlsIn(structural0)));

// ---------------------------------------------------------------------------
console.log('\n[1] real YouTube URLs survive, fabricated video URLs are removed');
check('evidence YouTube link kept (markdown)', structural0.includes('[video](https://www.youtube.com/watch?v=aBc123XyZ_9)'));
check('evidence YouTube URL kept (bare)', structural0.includes('https://www.youtube.com/watch?v=aBc123XyZ_9'));
check('fabricated YouTube video removed', !hasText(structural0, 'fake123xyz'), JSON.stringify(urlsIn(structural0)));
check('no fabricated video URL remains anywhere', !urlsIn(structural0).some((u) => u.includes('youtube.com/watch?v=FAKE')));

// ---------------------------------------------------------------------------
console.log('\n[2] invalid [n] citation markers removed, valid ones survive');
check('out-of-range marker [9] removed', !structural0.includes('[9]'), structural0.slice(0, 200));
check('valid marker [1] survives', structural0.includes('[1]'));
check('valid marker [2] survives', structural0.includes('[2]'));
check('sanitizeCitations bounds markers to the source count', sanitizeCitations('a [1] b [3] c [9] d [0]', 3) === 'a [1] b [3] c  d ');
check('zero sources -> every marker removed', sanitizeCitations('claim [1] and [2]', 0) === 'claim  and ');
check('marker followed by a link is not mangled', sanitizeCitations('[1](https://example.org/a)', 1) === '[1](https://example.org/a)');

// ---------------------------------------------------------------------------
console.log('\n[3] no-search / no-source behaviour');
const untouched = 'Plain answer with [docs](https://anything-else.example/doc) and marker [2].';
const noSearch = await groundAnswer({ question: 'q', evidence: '', sources: [], text: untouched, checker: echoChecker });
check('no evidence -> draft returned untouched', noSearch === untouched, JSON.stringify(noSearch));
const noSearchStream = await collect(createGroundedStream({ question: 'q', evidence: '', sources: [], checker: echoChecker }, asChunks(untouched)));
check('no evidence -> stream passed through untouched', noSearchStream === untouched, JSON.stringify(noSearchStream));
const noSourcesNoResults = await groundAnswer({
  question: 'q',
  evidence: NO_RESULTS_CONTEXT,
  sources: [],
  text: 'See https://anywhere.example/doc for details.',
  checker: echoChecker,
});
check('zero results -> evidence URLs are not linkable', !noSourcesNoResults.includes('https://anywhere.example/doc'), noSourcesNoResults);

// ---------------------------------------------------------------------------
console.log('\n[4]-[6],[9] live evidence check of a crafted draft');
const t0 = Date.now();
const grounded = await groundAnswer({ question: 'what changed in Acme Ledger and what does it cost?', evidence: fixtureEvidence, sources: fixtureSources, text: DRAFT });
console.log(`   · live check took ${((Date.now() - t0) / 1000).toFixed(1)}s, ${DRAFT.length} -> ${grounded.length} chars`);

check('supported fact survives: 38 percent', /38\s*(percent|%)/i.test(grounded), grounded);
check('supported fact survives: version 4.2', grounded.includes('4.2'), grounded);
check('supported fact survives: 12 dollars', /(12\s*dollars|shared budget|\$12)/i.test(grounded), grounded);
check('supported citations survive', grounded.includes('[1]') && grounded.includes('[2]'), grounded);

check('unsupported statistic removed', !grounded.includes('97.4'), grounded);
check('unsupported version removed', !grounded.includes('9.3'), grounded);
check('unsupported date removed', !grounded.includes('2027'), grounded);
check('unsupported entity removed', !hasText(grounded, 'qwartz'), grounded);
check('unsupported feature removed', !hasText(grounded, 'offline mobile'), grounded);
check('fabricated source name removed', !hasText(grounded, 'gartner'), grounded);
check('fabricated URL removed by the evidence check too', !hasText(grounded, 'totally-not-real.test'), grounded);
check('fabricated video ID removed', !hasText(grounded, 'fake123xyz'), grounded);
check('invalid citation marker stays removed', !grounded.includes('[9]'), grounded);

check('unsupported table values removed', !grounded.includes('999') && !hasText(grounded, 'audit logs'), grounded);
check('supported table values survive', /(12\s*dollars|shared budget)/i.test(grounded), grounded);

const codeNow = fenceInner(grounded);
check('code block remains byte-identical', codeNow === CODE_BLOCK, JSON.stringify(codeNow));

// ---------------------------------------------------------------------------
console.log('\n[7] conflicting sources are preserved with attribution');
const conflictSources = [
  { title: 'Lab A throughput study', url: 'https://lab-a.example/kestrel-throughput', content: 'Study A measured a throughput gain of 38 percent after the update.' },
  { title: 'Lab B throughput study', url: 'https://lab-b.example/kestrel-report', content: 'Study B measured a throughput gain of 22 percent after the same update.' },
];
const conflictDraft = 'Study A reports a gain of 38 percent [1], while Study B reports 22 percent [2].';
const conflictOut = await groundAnswer({
  question: 'how much faster is the pipeline after the update?',
  evidence: buildSearchContext(conflictSources),
  sources: conflictSources,
  text: conflictDraft,
});
console.log('   ·', conflictOut);
check('both conflicting figures survive', conflictOut.includes('38') && conflictOut.includes('22'), conflictOut);
check('both attributions survive', conflictOut.includes('[1]') && conflictOut.includes('[2]'), conflictOut);

// ---------------------------------------------------------------------------
console.log('\n[8] insufficient evidence must not produce hallucinated claims');
const emptyDraft = 'The Team plan costs 97.4 dollars per user per month, version 9.3 shipped on 15 January 2027, and Qwartz Labs confirmed it. See https://totally-not-real.test/pricing [1] and [9].';
const emptyOut = await groundAnswer({ question: 'what does it cost and when did it ship?', evidence: NO_RESULTS_CONTEXT, sources: [], text: emptyDraft });
console.log('   ·', emptyOut);
check('unsupported statistic not asserted', !emptyOut.includes('97.4'), emptyOut);
check('unsupported date/version not asserted', !emptyOut.includes('2027') && !emptyOut.includes('9.3'), emptyOut);
check('unsupported entity not asserted', !assertsToken(emptyOut, 'qwartz'), emptyOut);
check('no URL without evidence', urlsIn(emptyOut).length === 0, JSON.stringify(urlsIn(emptyOut)));
check('no citation without sources', markersIn(emptyOut).length === 0, JSON.stringify(markersIn(emptyOut)));
check('answer is honest instead of asserting', emptyOut.trim() === '' || /(confirm|could not|couldn'?t|cannot|no results|not enough|insufficient|unable|nothing)/i.test(emptyOut), emptyOut);

// ---------------------------------------------------------------------------
console.log('\n[10] streaming and non-streaming give the same guarantees');
const t1 = Date.now();
const streamed = await collect(createGroundedStream(
  { question: 'what changed in Acme Ledger and what does it cost?', evidence: fixtureEvidence, sources: fixtureSources },
  asChunks(DRAFT, 11),
));
console.log(`   · streamed check took ${((Date.now() - t1) / 1000).toFixed(1)}s, ${streamed.length} chars`);
check('streaming produced output', streamed.trim().length > 0);
check('streaming: supported facts survive', /38\s*(percent|%)/i.test(streamed) && streamed.includes('[1]'), streamed.slice(0, 400));
check('streaming: unsupported claims removed', !UNSUPPORTED.some((token) => hasText(streamed, token)), JSON.stringify(UNSUPPORTED.filter((token) => hasText(streamed, token))));
check('streaming: every URL comes from the evidence', urlsIn(streamed).every((u) => fixtureAllow.has(u.replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '').toLowerCase())), JSON.stringify(urlsIn(streamed)));
check('streaming: real YouTube URL survives', streamed.includes('https://www.youtube.com/watch?v=aBc123XyZ_9'));
check('streaming: code block byte-identical', fenceInner(streamed) === CODE_BLOCK, JSON.stringify(fenceInner(streamed)));
check('non-streaming removed the same unsupported claims', !UNSUPPORTED.some((token) => hasText(grounded, token)), JSON.stringify(UNSUPPORTED.filter((token) => hasText(grounded, token))));
check('streaming and non-streaming agree on the supported facts', /38\s*(percent|%)/i.test(grounded) && /38\s*(percent|%)/i.test(streamed));

// ---------------------------------------------------------------------------
console.log('\n[11] contextual follow-up resolves the previous subject and stays grounded');
const history = [
  { role: 'user', content: 'Tell me about the Voyager 1 spacecraft' },
  { role: 'assistant', content: 'Voyager 1 is a NASA probe launched in 1977 to study the outer Solar System; it is now in interstellar space.' },
];
const followUp = 'how far away is it now?';
const stage = await runWebSearchStage(followUp, history);
console.log(`   · stage=${stage.type} query=${JSON.stringify(stage.metadata?.webSearch?.query)} sources=${stage.sources?.length}`);
check('follow-up produced a search', stage.type === 'search' && (stage.sources || []).length > 0, JSON.stringify(stage.metadata?.webSearch));
check('query is not the literal follow-up', stage.metadata?.webSearch?.query !== followUp, stage.metadata?.webSearch?.query);
check('query carries the earlier subject', /voyager/i.test(stage.metadata?.webSearch?.query || ''), stage.metadata?.webSearch?.query);

const webCtx = { text: stage.contextText, sources: stage.sources };
const webAllow = buildUrlAllowlist(stage.sources);
const banned = /(knowledge cutoff|cannot browse|don'?t have real-time|search google)/i;
const messages = [...history, { role: 'user', content: followUp }];

const plain = await processMessage({ messages, userContent: followUp, stream: false, webSearch: webCtx });
const plainText = String(plain?.content || '');
console.log('   · non-streamed:', plainText.slice(0, 160).replace(/\n/g, ' '));
check('non-streaming: answer produced', plainText.trim().length > 0);
check('non-streaming: no URLs outside the search results', urlsIn(plainText).every((u) => webAllow.has(u.replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '').toLowerCase())), JSON.stringify(urlsIn(plainText)));
check('non-streaming: citations stay within the sources', markersIn(plainText).every((m) => Number(m.slice(1, -1)) <= (stage.sources || []).length), JSON.stringify(markersIn(plainText)));
check('non-streaming: no knowledge-cutoff phrasing', !banned.test(plainText), plainText.slice(0, 300));

const streamedE2e = await collect(await processMessage({ messages, userContent: followUp, stream: true, webSearch: webCtx }));
console.log('   · streamed:', streamedE2e.slice(0, 160).replace(/\n/g, ' '));
check('streaming: answer produced', streamedE2e.trim().length > 0);
check('streaming: no URLs outside the search results', urlsIn(streamedE2e).every((u) => webAllow.has(u.replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '').toLowerCase())), JSON.stringify(urlsIn(streamedE2e)));
check('streaming: citations stay within the sources', markersIn(streamedE2e).every((m) => Number(m.slice(1, -1)) <= (stage.sources || []).length), JSON.stringify(markersIn(streamedE2e)));
check('streaming: no knowledge-cutoff phrasing', !banned.test(streamedE2e), streamedE2e.slice(0, 300));

// ---------------------------------------------------------------------------
console.log('\n[12] arbitrary domains/topics, no topic-specific rules');
const dynamicFixtures = [
  { subject: 'bar-tailed godwit migration', domain: 'bird-notes.example.org', path: '/godwit-nonstop', claim: 'flies more than 11,000 kilometres without landing', fakeDomain: 'fake-atlas.test', fakePath: '/godwit', fakeCite: 7 },
  { subject: 'filing a patent application in India', domain: 'ip-handbook.example.net', path: '/flow', claim: 'a provisional application is filed before the complete specification', fakeDomain: 'made-up.example.io', fakePath: '/fee', fakeCite: 9 },
  { subject: 'Turkish lira exchange rate today', domain: 'fx-daily.example.info', path: '/try', claim: 'the lira moved against the dollar during the week', fakeDomain: 'not-real.example.com', fakePath: '/try', fakeCite: 5 },
];
for (const f of dynamicFixtures) {
  const sources = [{ title: `${f.subject} overview`, url: `https://${f.domain}${f.path}`, content: f.claim }];
  const draft = `On ${f.subject}: ${f.claim} [1]. Background detail [${f.fakeCite}]. More in the [notes](https://${f.domain}${f.path}) and at https://${f.fakeDomain}${f.fakePath}.`;
  const out = await groundAnswer({ question: f.subject, evidence: buildSearchContext(sources), sources, text: draft, checker: echoChecker });
  const allow = buildUrlAllowlist(sources);
  check(`${f.domain}: evidence URL survives`, out.includes(`https://${f.domain}${f.path}`), out);
  check(`${f.fakeDomain}: fabricated URL removed`, !hasText(out, f.fakeDomain), out);
  check(`${f.domain}: supported claim and [1] survive`, hasText(out, f.claim.slice(0, 25)) && out.includes('[1]'), out);
  check(`${f.domain}: fabricated citation [${f.fakeCite}] removed`, !out.includes(`[${f.fakeCite}]`), out);
  check(`${f.domain}: only evidence URLs remain`, urlsIn(out).every((u) => allow.has(u.replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '').toLowerCase())), JSON.stringify(urlsIn(out)));
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
