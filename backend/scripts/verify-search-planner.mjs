// Dynamic verification for AURA's universal web-search / context-resolution
// pipeline.
//
//   node scripts/verify-search-planner.mjs
//
// The assertions are structural, not topic-specific: they prove that an
// arbitrary subject + an arbitrary short follow-up is resolved from
// conversation context, that irrelevant look-alike results are rejected and
// the search refined, that every link comes from a URL the search engine
// actually returned, that language is handled without any language rules in
// the code, and that streaming and non-streaming give the same guarantees.

import { runWebSearchStage } from '../src/controllers/chatController.js';
import { planSearch, evaluateResults } from '../src/services/searchPlanner.js';
import { buildSearchQuery } from '../src/services/searchQueryGenerator.js';
import * as webSearchService from '../src/services/webSearchService.js';
import { buildUrlAllowlist, sanitizeLinks, createLinkSanitizer } from '../src/services/webSearchService.js';
import { processMessage } from '../src/services/aiService.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`FAIL   ${name}${detail ? ` :: ${detail}` : ''}`); }
};

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/i).filter((w) => w.length > 3);
const sharesSubject = (a, b) => {
  const set = new Set(words(b));
  return words(a).some((w) => set.has(w));
};
const urlKey = (u) => String(u || '').toLowerCase().replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '');
const extractUrls = (text) => String(text || '').match(/https?:\/\/[^\s<>"'`]+/g) || [];
const leakedUrls = (text, allowed) => extractUrls(text).filter((u) => !allowed.has(urlKey(u)));
const planQueryOf = (stage) => stage?.metadata?.webSearch?.query || '';
const sourcesOf = (stage) => stage?.metadata?.webSearch?.sources || [];

const show = (label, stage) => {
  console.log(`   · ${label}: type=${stage.type} query=${JSON.stringify(planQueryOf(stage))} sources=${sourcesOf(stage).length}`);
};

// ---------------------------------------------------------------------------
console.log('\n[0] empty / whitespace input');
const emptyStage = await runWebSearchStage('', []);
check('empty message -> none', emptyStage.type === 'none');
const blankStage = await runWebSearchStage('   \n ', []);
check('whitespace message -> none', blankStage.type === 'none');

// ---------------------------------------------------------------------------
console.log('\n[1] arbitrary topic + arbitrary follow-up resolved from context');
const historyA = [
  { role: 'user', content: 'Tell me about the Reykjanes volcano eruptions in Iceland' },
  { role: 'assistant', content: 'The Reykjanes peninsula in south-west Iceland has been erupting repeatedly since 2021, with lava flows near Grindavik and evacuations of local residents.' },
];
const followA = 'give me a reliable link about it';
const stageA = await runWebSearchStage(followA, historyA);
show('contextual follow-up', stageA);
check('follow-up produced a search', stageA.type === 'search', JSON.stringify(stageA));
check('query is not the literal follow-up', planQueryOf(stageA) !== buildSearchQuery(followA), planQueryOf(stageA));
check('query carries the earlier subject', sharesSubject(planQueryOf(stageA), historyA[0].content), planQueryOf(stageA));
check('search returned usable sources', sourcesOf(stageA).length > 0);

// ---------------------------------------------------------------------------
console.log('\n[2] standalone arbitrary question searches correctly');
const standalone = 'why do some lakes turn pink';
const stageB = await runWebSearchStage(standalone, [{ role: 'user', content: standalone }]);
show('standalone', stageB);
check('standalone question -> search', stageB.type === 'search');
check('standalone query derived from the question', sharesSubject(planQueryOf(stageB), standalone), planQueryOf(stageB));
check('standalone search returned sources', sourcesOf(stageB).length > 0);

// ---------------------------------------------------------------------------
console.log('\n[3] a short follow-up is not searched literally');
const historyC = [
  { role: 'user', content: 'I am planning a trip to the Faroe Islands next month' },
  { role: 'assistant', content: 'The Faroe Islands are a North Atlantic archipelago between Iceland and Norway, known for cliffs, hiking and small villages.' },
];
const followC = 'how much would it cost';
const stageC = await runWebSearchStage(followC, historyC);
show('short follow-up', stageC);
check('follow-up produced a search', stageC.type === 'search');
check('literal cleaned follow-up was not used', planQueryOf(stageC) !== buildSearchQuery(followC), planQueryOf(stageC));
check('query carries the earlier subject', sharesSubject(planQueryOf(stageC), historyC[0].content), planQueryOf(stageC));

// ---------------------------------------------------------------------------
console.log('\n[4] irrelevant / similarly named results are rejected');
const rejectRequest = 'What is the launch price of the Nimbus X1 phone?';
const rejectResults = [
  { title: 'Nimbus X1 phone launch price', url: 'https://results.example/nimbus-x1-phone', content: 'The Nimbus X1 phone launched at a starting price of 499 with a mid-range chipset.' },
  { title: 'Nimbus X1 phone specifications', url: 'https://results.example/nimbus-x1-specs', content: 'Display, battery and camera specifications of the Nimbus X1 phone.' },
  { title: 'Nimbus Peak hiking trail guide', url: 'https://results.example/nimbus-peak-trail', content: 'A long day hike up Nimbus Peak with 900 metres of elevation gain.' },
  { title: 'What a nimbus cloud is', url: 'https://results.example/nimbus-cloud', content: 'A nimbus is a type of rain cloud, seen in meteorology.' },
  { title: 'X1 graphics card benchmark', url: 'https://results.example/x1-graphics-card', content: 'Benchmarks for the X1 graphics card in modern games.' },
];
const eval4 = await evaluateResults({ content: rejectRequest, history: [], query: 'Nimbus X1 phone price', results: rejectResults });
const keptUrls4 = eval4.kept.map((r) => r.url);
const unrelated4 = rejectResults.slice(2).map((r) => r.url);
console.log('   · kept:', JSON.stringify(keptUrls4), 'refinedQuery:', JSON.stringify(eval4.refinedQuery));
check('a matching result was kept', keptUrls4.includes('https://results.example/nimbus-x1-phone') || keptUrls4.includes('https://results.example/nimbus-x1-specs'), JSON.stringify(keptUrls4));
check('at least one look-alike was rejected', keptUrls4.filter((u) => unrelated4.includes(u)).length < unrelated4.length, JSON.stringify(keptUrls4));
check('not everything was accepted', eval4.kept.length < rejectResults.length, JSON.stringify(keptUrls4));

// ---------------------------------------------------------------------------
console.log('\n[5] search is refined when the first results are irrelevant');
const refineRequest = rejectRequest;
const goodResults = rejectResults.slice(0, 2);
const badResults = rejectResults.slice(2);
const searchCalls = [];
const fakeSearch = async (q) => {
  searchCalls.push(q);
  return { enabled: true, results: searchCalls.length === 1 ? badResults : goodResults };
};
const plan5 = await planSearch({ content: refineRequest, history: [], search: fakeSearch });
console.log('   · searches:', JSON.stringify(searchCalls), 'refined:', plan5.refined, 'sources:', plan5.sources.length);
check('a second, different search was issued', searchCalls.length === 2 && searchCalls[1] !== searchCalls[0], JSON.stringify(searchCalls));
check('the plan is marked refined', plan5.refined === true);
check('final sources came from the refined search', plan5.sources.length > 0 && plan5.sources.every((r) => goodResults.some((g) => g.url === r.url)), JSON.stringify(plan5.sources.map((r) => r.url)));

// ---------------------------------------------------------------------------
console.log('\n[6] sources come only from URLs the search engine returned');
const seenUrls = [];
const spySearch = async (q) => {
  const res = await webSearchService.searchWeb(q);
  for (const r of res.results || []) seenUrls.push(r.url);
  return res;
};
const request6 = 'official documentation for the Rust programming language ownership rules';
const plan6 = await planSearch({ content: request6, history: [], search: spySearch });
console.log('   · query:', JSON.stringify(plan6.query), 'sources:', plan6.sources.length, 'returned:', seenUrls.length);
check('search produced sources', plan6.status === 'ok' && plan6.sources.length > 0, JSON.stringify(plan6));
check('every source URL was returned by the search engine', plan6.sources.every((s) => seenUrls.includes(s.url)), JSON.stringify(plan6.sources.map((s) => s.url)));

// ---------------------------------------------------------------------------
console.log('\n[7] no fabricated URLs');
const allow7 = buildUrlAllowlist(plan6.sources);
const realUrl = plan6.sources[0]?.url || '';
const modelText = `Useful links: [ownership book](https://rust-lang-book-fake.test/ownership), https://www.youtube.com/watch?v=AAAAAAAAAAA, and the real one ${realUrl}.`;
const filtered7 = sanitizeLinks(modelText, allow7);
console.log('   · filtered:', JSON.stringify(filtered7));
check('fabricated markdown link de-linked', !filtered7.includes('rust-lang-book-fake.test'), filtered7);
check('fabricated video id removed', !filtered7.includes('AAAAAAAAAAA'), filtered7);
check('real search URL preserved', realUrl ? filtered7.includes(realUrl) : false, filtered7);
const sanitizer7 = createLinkSanitizer(allow7);
let streamed7 = '';
for (const chunk of modelText.match(/.{1,7}/g) || []) streamed7 += sanitizer7.push(chunk);
streamed7 += sanitizer7.flush();
check('streaming filter matches one-shot filter', streamed7 === filtered7, JSON.stringify(streamed7));

// ---------------------------------------------------------------------------
console.log('\n[8] language handled dynamically (no language rules in code)');
const request8 = '¿Cuál es la capital de Mongolia y su población?';
const stage8 = await runWebSearchStage(request8, []);
show('spanish request', stage8);
check('non-English request -> search', stage8.type === 'search');
check('query derived from the request language/content', sharesSubject(planQueryOf(stage8), request8), planQueryOf(stage8));
check('non-English search returned sources', sourcesOf(stage8).length > 0);

// ---------------------------------------------------------------------------
console.log('\n[9] arbitrary domains/topics work with no topic-specific code');
const probes = [
  'how do I file a patent application in India',
  'migration distance of the bar-tailed godwit',
  'exchange rate of the Turkish lira today',
];
for (const probe of probes) {
  const stage = await runWebSearchStage(probe, []);
  show(probe.slice(0, 40), stage);
  check(`searched: ${probe.slice(0, 40)}`, stage.type === 'search' && sourcesOf(stage).length > 0, JSON.stringify(stage.metadata?.webSearch?.query));
}

// ---------------------------------------------------------------------------
console.log('\n[10] streaming and non-streaming keep the same relevance/link guarantees');
const webCtx10 = {
  text: webSearchService.buildSearchContext(plan6.sources),
  sources: plan6.sources,
};
const allow10 = buildUrlAllowlist(plan6.sources);
const messages10 = [{ role: 'user', content: request6 }];

const gen10 = await processMessage({ messages: messages10, userContent: request6, stream: true, webSearch: webCtx10 });
let streamed10 = '';
for await (const chunk of gen10) streamed10 += chunk;
const plain10 = await processMessage({ messages: messages10, userContent: request6, stream: false, webSearch: webCtx10 });

const banned = /(knowledge cutoff|cannot browse|don'?t have real-time|search google)/i;
console.log('   · stream chars:', streamed10.length, 'plain chars:', String(plain10.content || '').length);
check('streaming answer produced', streamed10.trim().length > 0);
check('non-streaming answer produced', String(plain10.content || '').trim().length > 0);
check('streaming: no URLs outside the search results', leakedUrls(streamed10, allow10).length === 0, JSON.stringify(leakedUrls(streamed10, allow10)));
check('non-streaming: no URLs outside the search results', leakedUrls(plain10.content, allow10).length === 0, JSON.stringify(leakedUrls(plain10.content, allow10)));
check('streaming: no knowledge-cutoff phrasing', !banned.test(streamed10));
check('non-streaming: no knowledge-cutoff phrasing', !banned.test(plain10.content));

// ---------------------------------------------------------------------------
console.log('\n[11] graceful degradation (auxiliary AI unavailable, search disabled/failed)');
const { resolveSearchQuery } = await import('../src/services/searchPlanner.js');
const { default: env } = await import('../src/config/env.js');
const hadKey = env.hasAiKey;
env.hasAiKey = false;
try {
  const fallbackQ = await resolveSearchQuery({ content: followC, history: historyC });
  console.log('   · fallback query:', JSON.stringify(fallbackQ));
  check('no-AI: fallback query still carries the earlier subject', sharesSubject(fallbackQ, historyC[0].content), fallbackQ);
  check('no-AI: fallback query is not the literal follow-up', fallbackQ !== buildSearchQuery(followC), fallbackQ);

  const fallbackEval = await evaluateResults({ content: rejectRequest, history: [], query: 'q', results: rejectResults });
  check('no-AI: results are kept instead of discarded', fallbackEval.kept.length === rejectResults.length && fallbackEval.skipped === true, JSON.stringify(fallbackEval));

  const standaloneQ = await resolveSearchQuery({ content: standalone, history: [] });
  check('no-AI: standalone query unchanged', standaloneQ === buildSearchQuery(standalone), standaloneQ);
} finally {
  env.hasAiKey = hadKey;
}

const disabledPlan = await planSearch({ content: standalone, history: [], search: async () => ({ enabled: false, results: [] }) });
check('disabled search -> disabled status', disabledPlan.status === 'disabled');
const failedPlan = await planSearch({ content: standalone, history: [], search: async () => { throw new Error('provider down'); } });
check('failing search -> failed status', failedPlan.status === 'failed' && failedPlan.error?.message === 'provider down');

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
