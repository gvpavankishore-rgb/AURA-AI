// Dynamic verification for AURA's typo / intent-understanding layer.
//
//   node scripts/verify-typo-intent.mjs
//
// Proves that a misspelled or ungrammatical message is understood and
// corrected BEFORE any web search, that the corrected meaning drives the
// search, that genuinely ambiguous messages ask for a short clarification
// instead of guessing, that an unrelated result whose name merely resembles a
// misspelled word is rejected, and that streaming and non-streaming keep the
// same guarantees. No specific misspelling is hardcoded in the product code;
// the assertions are structural.

import { runWebSearchStage } from '../src/controllers/chatController.js';
import { resolveSearchIntent, parseResolution, planSearch, evaluateResults } from '../src/services/searchPlanner.js';
import { buildSearchQuery } from '../src/services/searchQueryGenerator.js';
import * as webSearchService from '../src/services/webSearchService.js';
import { buildUrlAllowlist } from '../src/services/webSearchService.js';
import { processMessage } from '../src/services/aiService.js';
import env from '../src/config/env.js';

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
const urlsIn = (s) => String(s || '').match(/https?:\/\/[^\s<>"'`)\]]+/g) || [];
const key = (u) => webSearchService.normalizeUrlKey(String(u).replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, ''));
const collect = async (gen) => {
  let out = '';
  for await (const chunk of gen) out += String(chunk);
  return out;
};
const banned = /(knowledge cutoff|cannot browse|don'?t have real-time|search google)/i;

// ---------------------------------------------------------------------------
console.log('\n[0] the resolver reply is parsed deterministically');
const c0 = parseResolution('CLARIFY: Did you mean who created these, or what created these?');
check('clarify line -> clarification', c0 && !c0.query && /did you mean/i.test(c0.clarification), JSON.stringify(c0));
const c0b = parseResolution('CLARIFY:Which country did you mean?');
check('clarify without space -> clarification', c0b && !c0b.query && /which country/i.test(c0b.clarification), JSON.stringify(c0b));
const q0 = parseResolution('who created these');
check('plain line -> query', q0 && q0.query === 'who created these' && !q0.clarification, JSON.stringify(q0));
check('empty reply -> null', parseResolution('') === null);

// ---------------------------------------------------------------------------
console.log('\n[1] a misspelled message is corrected, not searched literally (live)');
const typo = 'wh creat these';
const intent1 = await resolveSearchIntent({ content: typo, history: [] });
console.log('   · resolved:', JSON.stringify(intent1));
if (intent1.clarification) {
  check('misspelled message -> short clarification (no literal search)', intent1.clarification.length <= 300 && intent1.query === '', JSON.stringify(intent1));
} else {
  check('misspelled message -> a query was produced', !!intent1.query, JSON.stringify(intent1));
  check('query does not contain the raw misspelling', !/\bcreeat\b/i.test(intent1.query) && !/\bcreat\b/i.test(intent1.query) && !/\bwh\b/i.test(intent1.query), intent1.query);
  check('query is not the literal cleaned misspelling', intent1.query !== buildSearchQuery(typo), intent1.query);
}

// ---------------------------------------------------------------------------
console.log('\n[2] a misspelled factual question searches its intended meaning (live)');
const typoFact = 'who invnted the telphone';
const intent2 = await resolveSearchIntent({ content: typoFact, history: [] });
console.log('   · resolved:', JSON.stringify(intent2));
check('factual typo -> no clarification', !intent2.clarification, JSON.stringify(intent2));
check('factual typo -> corrected subject in query', /invent/i.test(intent2.query || '') && /telephone|phone/i.test(intent2.query || ''), intent2.query);
check('factual typo -> raw misspellings absent', !/invnted|telphone/i.test(intent2.query || ''), intent2.query);
const plan2 = await planSearch({ content: typoFact, history: [] });
console.log(`   · plan status=${plan2.status} query=${JSON.stringify(plan2.query)} sources=${(plan2.sources || []).length}`);
check('factual typo -> search succeeded with sources', plan2.status === 'ok' && (plan2.sources || []).length > 0, JSON.stringify(plan2));
check('factual typo -> searched query is the corrected one', !/invnted|telphone/i.test(plan2.query || ''), plan2.query);

// ---------------------------------------------------------------------------
console.log('\n[3] a correctly spelled question keeps working unchanged (live)');
const clean = 'what is the capital of Mongolia';
const intent3 = await resolveSearchIntent({ content: clean, history: [] });
check('clean question -> no clarification', !intent3.clarification, JSON.stringify(intent3));
check('clean question -> query carries the subject', sharesSubject(intent3.query, clean), intent3.query);
const plan3 = await planSearch({ content: clean, history: [] });
check('clean question -> search succeeded', plan3.status === 'ok' && (plan3.sources || []).length > 0, JSON.stringify(plan3));

// ---------------------------------------------------------------------------
console.log('\n[4] ambiguous intent asks for clarification instead of guessing (controller mapping)');
const fakeClarifyPlanner = async () => ({ status: 'clarify', query: '', clarification: 'Did you mean X or Y?' });
const clarifyStage = await runWebSearchStage('ambiguous', [], fakeClarifyPlanner);
check('clarify plan -> static clarification response', clarifyStage.type === 'static' && clarifyStage.content === 'Did you mean X or Y?', JSON.stringify(clarifyStage));
check('clarify response exposes no sources', !(clarifyStage.sources && clarifyStage.sources.length), JSON.stringify(clarifyStage.metadata));

// ---------------------------------------------------------------------------
console.log('\n[5] an unrelated result whose name resembles a misspelling is rejected (live)');
const brandResults = [
  { title: 'Creeat - Creative branding agency', url: 'https://creeat.example/', content: 'Creeat is a studio offering brand identity and design services.' },
  { title: 'Creeat app download', url: 'https://creeat.example/app', content: 'Download the Creeat app for creative teams.' },
];
const eval5 = await evaluateResults({ content: typo, history: [], query: 'who created these', results: brandResults });
console.log('   · kept:', JSON.stringify(eval5.kept.map((r) => r.url)), 'refined:', JSON.stringify(eval5.refinedQuery));
const keptBrand = eval5.kept.filter((r) => /creeat/i.test(`${r.title} ${r.url} ${r.content}`));
check('look-alike brand results rejected', keptBrand.length === 0, JSON.stringify(eval5.kept.map((r) => r.url)));

// ---------------------------------------------------------------------------
console.log('\n[6] contextual follow-up with typos preserves the previous topic (live)');
const history6 = [
  { role: 'user', content: 'Tell me about the Voyager 1 spacecraft' },
  { role: 'assistant', content: 'Voyager 1 is a NASA probe launched in 1977 to study the outer Solar System.' },
];
const intent6 = await resolveSearchIntent({ content: 'how far is it nw', history: history6 });
console.log('   · resolved:', JSON.stringify(intent6));
check('typo follow-up -> no clarification', !intent6.clarification, JSON.stringify(intent6));
check('typo follow-up -> carries the earlier subject', sharesSubject(intent6.query, history6[0].content), intent6.query);
const stage6 = await runWebSearchStage('how far is it nw', history6);
check('typo follow-up -> search with sources', stage6.type === 'search' && (stage6.sources || []).length > 0, JSON.stringify(stage6.metadata?.webSearch));

// ---------------------------------------------------------------------------
console.log('\n[7] streaming and non-streaming keep the same guarantees (live)');
if (plan2.status === 'ok' && (plan2.sources || []).length > 0) {
  const webCtx = { text: webSearchService.buildSearchContext(plan2.sources), sources: plan2.sources };
  const allow = buildUrlAllowlist(plan2.sources);
  const messages = [{ role: 'user', content: typoFact }];
  const streamed = await collect(await processMessage({ messages, userContent: typoFact, stream: true, webSearch: webCtx }));
  const plain = await processMessage({ messages, userContent: typoFact, stream: false, webSearch: webCtx });
  const plainText = String(plain?.content || '');
  check('streaming answer produced', streamed.trim().length > 0);
  check('non-streaming answer produced', plainText.trim().length > 0);
  check('streaming: no URLs outside the search results', urlsIn(streamed).every((u) => allow.has(key(u))), JSON.stringify(urlsIn(streamed)));
  check('non-streaming: no URLs outside the search results', urlsIn(plainText).every((u) => allow.has(key(u))), JSON.stringify(urlsIn(plainText)));
  check('streaming: no knowledge-cutoff phrasing', !banned.test(streamed));
  check('non-streaming: no knowledge-cutoff phrasing', !banned.test(plainText));
} else {
  check('streaming/non-streaming skipped (no sources to ground on)', false, JSON.stringify(plan2));
}

// ---------------------------------------------------------------------------
console.log('\n[8] graceful degradation (no AI): deterministic literal fallback');
const hadKey = env.hasAiKey;
env.hasAiKey = false;
try {
  const fb = await resolveSearchIntent({ content: typo, history: [] });
  check('no-AI: literal fallback query', fb.query === buildSearchQuery(typo) && !fb.clarification, JSON.stringify(fb));
} finally {
  env.hasAiKey = hadKey;
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
