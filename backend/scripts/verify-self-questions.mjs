// Dynamic verification for the two-source behavior: web evidence vs the
// assistant's own application context.
//
//   node scripts/verify-self-questions.mjs
//   SKIP_LIVE=1 node scripts/verify-self-questions.mjs   (deterministic-only)
//
// Proves that EVERY question still goes through the web-search stage, while an
// empty/unhelpful search no longer forces a "search found nothing" answer when
// the question is about AURA itself or is stable general knowledge:
//
//   [0]  no-evidence prompt answers from application context, never exposes the search
//   [1]  evidence prompt is still strict when results exist
//   [2]  no search -> neither web block is injected
//   [3]  grounding chooses no-evidence mode vs strict mode from the sources
//   [4]  the grounding layer never adds a search-failure disclaimer by itself
//   [5]  streaming and non-streaming follow the same no-evidence rules
//   [6]  resource request with no results -> no fabricated card/URL
//   [7]  resource request with a valid result -> that exact URL only
//   [8]  no hardcoded self-question detection anywhere in the service layer
//   [9]  live: self questions answer without the ugly disclaimer
//   [10] live: a current question with results stays evidence-grounded
//   [11] live: a current question with no useful results does not invent facts
//   [12] live: a self question after a previous topic is not contaminated
//   [13] live: a genuine follow-up still keeps the previous subject

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSystemPrompt, processMessage } from '../src/services/aiService.js';
import { groundAnswer, createGroundedStream } from '../src/services/answerGrounder.js';
import { runWebSearchStage } from '../src/controllers/chatController.js';
import { resolveSearchQuery } from '../src/services/searchPlanner.js';
import { buildResource } from '../src/services/resourceCard.js';
import { buildSearchContext, NO_RESULTS_CONTEXT } from '../src/services/webSearchService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.SKIP_LIVE !== '1';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`FAIL   ${name}${detail ? ` :: ${detail}` : ''}`); }
};
const lower = (s) => String(s || '').toLowerCase();
const urlsIn = (s) => String(s || '').match(/https?:\/\/[^\s<>"'`]+/g) || [];
const collect = async (gen) => {
  let out = '';
  for await (const chunk of gen) out += String(chunk);
  return out;
};
const asChunks = (text, size = 11) => (async function* () {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
})();

// Phrases that must not appear when a valid answer can be given from context.
const UGLY = [
  /did not return any relevant results/i,
  /search did not return/i,
  /web search results do not provide/i,
  /available search results do not confirm/i,
  /returned NO relevant results/i,
  /couldn'?t find any useful web results/i,
  /reliable web information (was|is) not found/i,
];
const hasUgly = (s) => UGLY.some((re) => re.test(String(s || '')));

// A draft that is a normal self-description (application context).
const SELF_DRAFT = 'Hi! I am AURA, a multimodal AI assistant created by Pavan Kishore. I can help with conversations, coding, images, documents, translation, voice and web search.';
// A draft full of current/external specifics that an empty search cannot support.
const CURRENT_DRAFT = 'The latest version is 9.3, released on 15 January 2027, and it costs 97.4 dollars per month. See https://totally-not-real.test/pricing [1] and [9].';

// ---------------------------------------------------------------------------
console.log('\n[0] no-evidence prompt answers from application context, never exposes the search');
const noEvPrompt = getSystemPrompt({
  webSearchText: NO_RESULTS_CONTEXT,
  webSearchHasResults: false,
});
check('no-evidence prompt is selected', noEvPrompt.includes('returned no usable results'), noEvPrompt.slice(0, 120));
check('does NOT impose the strict evidence-is-source-of-truth rule', !noEvPrompt.includes('SOURCE OF TRUTH'));
check('instructs answering from the application context', /application context/i.test(noEvPrompt) && /about you|assistant|AURA/i.test(noEvPrompt));
check('forbids mentioning the search', /never mention the search/i.test(noEvPrompt));
check('forbids inventing current/external facts', /current or external facts/i.test(noEvPrompt));
check('contains AURA capabilities', lower(noEvPrompt).includes('web search') && lower(noEvPrompt).includes('voice input'), '');
check('does not contain an ugly disclaimer instruction', !hasUgly(noEvPrompt));

// ---------------------------------------------------------------------------
console.log('\n[1] evidence prompt is still strict when results exist');
const evPrompt = getSystemPrompt({
  webSearchText: buildSearchContext([{ title: 'Example', url: 'https://example.test/a', content: 'Example body.' }]),
  webSearchHasResults: true,
});
check('evidence prompt requires grounding', evPrompt.includes('SOURCE OF TRUTH'));
check('evidence prompt includes the results block', evPrompt.includes('[Web Search Results]') && evPrompt.includes('https://example.test/a'));
check('evidence prompt is NOT the no-evidence prompt', !evPrompt.includes('returned no usable results'));

// ---------------------------------------------------------------------------
console.log('\n[2] no search -> neither web block is injected');
const plainPrompt = getSystemPrompt({});
check('no web rules without a search', !plainPrompt.includes('SOURCE OF TRUTH') && !plainPrompt.includes('returned no usable results'));
check('application context still present', plainPrompt.includes('Application context - about AURA itself'));

// ---------------------------------------------------------------------------
console.log('\n[3] grounding chooses no-evidence mode vs strict mode from the sources');
const capNo = [];
const outNo = await groundAnswer({
  question: 'tell me about yourself',
  evidence: NO_RESULTS_CONTEXT,
  sources: [],
  text: SELF_DRAFT,
  checker: async (args) => { capNo.push(args); return args.segment; },
});
check('empty sources -> noEvidence=true', capNo.length === 1 && capNo[0].noEvidence === true, JSON.stringify(capNo[0]?.noEvidence));
check('self description survives the no-evidence pass', outNo.includes('AURA') && outNo.includes('multimodal AI assistant'), outNo);
check('no disclaimer added to a self description', !hasUgly(outNo), outNo);

const capEv = [];
await groundAnswer({
  question: 'what is the latest version?',
  evidence: buildSearchContext([{ title: 'Releases', url: 'https://example.test/releases', content: 'Version 9.3 shipped.' }]),
  sources: [{ title: 'Releases', url: 'https://example.test/releases' }],
  text: 'Version 9.3 shipped [1].',
  checker: async (args) => { capEv.push(args); return args.segment; },
});
check('present sources -> noEvidence=false', capEv.length === 1 && capEv[0].noEvidence === false, JSON.stringify(capEv[0]?.noEvidence));

// ---------------------------------------------------------------------------
console.log('\n[4] the grounding layer never adds a search-failure disclaimer by itself');
check('echo checker + empty sources -> draft unchanged', outNo.trim() === SELF_DRAFT.trim(), outNo);
const currentOut = await groundAnswer({
  question: 'what is the latest version?',
  evidence: NO_RESULTS_CONTEXT,
  sources: [],
  text: CURRENT_DRAFT,
  checker: async (args) => {
    // Simulate the no-evidence checker contract: with no evidence, current
    // specifics and links/citations are dropped; a self/stable answer is kept.
    if (!args.noEvidence) return args.segment;
    return 'I could not reliably confirm the latest version or price.';
  },
});
check('no-evidence: fabricated specifics removed', !/9\.3|97\.4|2027/.test(currentOut), currentOut);
check('no-evidence: no fabricated URL remains', urlsIn(currentOut).length === 0, currentOut);
check('no-evidence: no citation remains', !/\[\d+\]/.test(currentOut), currentOut);
check('no-evidence: current question gets an honest, non-ugly line', !hasUgly(currentOut) && /confirm/i.test(currentOut), currentOut);

// ---------------------------------------------------------------------------
console.log('\n[5] streaming and non-streaming follow the same no-evidence rules');
const streamedSelf = await collect(createGroundedStream(
  { question: 'tell me about yourself', evidence: NO_RESULTS_CONTEXT, sources: [], checker: async ({ segment }) => segment },
  asChunks(SELF_DRAFT, 7),
));
check('streaming: self description survives', streamedSelf.includes('AURA') && streamedSelf.includes('multimodal AI assistant'), streamedSelf);
check('streaming: no disclaimer added', !hasUgly(streamedSelf), streamedSelf);
check('streaming and non-streaming agree', streamedSelf.trim() === outNo.trim(), JSON.stringify({ streamedSelf, outNo }));

const streamCap = [];
await collect(createGroundedStream(
  { question: 'q', evidence: NO_RESULTS_CONTEXT, sources: [], checker: async (a) => { streamCap.push(a); return a.segment; } },
  asChunks('hello world', 3),
));
check('streaming: noEvidence flag forwarded', streamCap.length >= 1 && streamCap.every((a) => a.noEvidence === true), JSON.stringify(streamCap.map((a) => a.noEvidence)));

// ---------------------------------------------------------------------------
console.log('\n[6] resource request with no results -> no fabricated card/URL');
const noResCard = buildResource({
  raw: JSON.stringify({ type: 'video', title: 'Some Trailer', primaryLink: 'https://www.youtube.com/watch?v=FAKEfakeFAKE', images: [], metadata: [] }),
  sources: [],
  images: [],
});
check('no results -> resource card is null', noResCard === null, JSON.stringify(noResCard));
check('no-evidence prompt has the resource rule', /specific resource/i.test(noEvPrompt) && /never invent one/i.test(noEvPrompt));

// ---------------------------------------------------------------------------
console.log('\n[7] resource request with a valid result -> that exact URL only');
const src = [{ title: 'Official Zorblax page', url: 'https://zorblax.example/watch', content: 'The official Zorblax video page.' }];
const goodCard = buildResource({
  raw: JSON.stringify({ type: 'video', title: 'Official Zorblax page', primaryLink: 'https://zorblax.example/watch', images: [], metadata: [] }),
  sources: src,
  images: [],
});
check('valid result -> card uses the search URL', goodCard && goodCard.primaryLink === 'https://zorblax.example/watch', JSON.stringify(goodCard));
check('valid result -> no unrelated URL', goodCard && urlsIn(JSON.stringify(goodCard)).every((u) => u.startsWith('https://zorblax.example/')), JSON.stringify(goodCard));

// ---------------------------------------------------------------------------
console.log('\n[8] no hardcoded self-question detection anywhere in the service layer');
const servicesDir = path.resolve(__dirname, '../src/services');
const files = fs.readdirSync(servicesDir).filter((f) => f.endsWith('.js'));
const srcs = files.map((f) => ({ f, text: fs.readFileSync(path.join(servicesDir, f), 'utf8') }));
const allSrc = srcs.map((s) => s.text).join('\n');
const hardcodedPhrases = ['tell me about yourself', 'who are you', 'what can you do', 'how do you work'];
for (const p of hardcodedPhrases) {
  check(`no literal "${p}" in services`, !lower(allSrc).includes(p));
}
const questionEquality = srcs.filter((s) => /(userContent|question|message)\s*===\s*['"]/i.test(s.text)).map((s) => s.f);
check('no question/message equality hardcoding', questionEquality.length === 0, questionEquality.join(', '));
check('services scanned', files.length >= 6, files.join(', '));

// ---------------------------------------------------------------------------
if (LIVE) {
  const runSelf = async (question, history = []) => {
    const stage = await runWebSearchStage(question, history);
    const webSearch = stage.type === 'search'
      ? { sources: stage.sources, images: stage.images || [], text: stage.contextText }
      : null;
    const messages = [...history, { role: 'user', content: question }];
    const out = await processMessage({ messages, userContent: question, stream: false, webSearch });
    return { stage, content: String(out?.content || '') };
  };

  console.log('\n[9] live: self questions answer without the ugly disclaimer');
  const selfQuestions = ['tell me about yourself', 'who are you?', 'what can you do?', 'how do you work?'];
  for (const q of selfQuestions) {
    const { stage, content } = await runSelf(q);
    const okType = stage.type === 'search' || stage.type === 'static';
    check(`"${q}": question went through the search stage`, okType, stage.type);
    check(`"${q}": no ugly internal search message`, !hasUgly(content), content.slice(0, 240));
    check(`"${q}": produced a real answer`, content.trim().length > 0, content.slice(0, 120));
  }

  console.log('\n[10] live: a current question with results stays evidence-grounded');
  const currentQ = 'latest stable version of Node.js';
  const cur = await runSelf(currentQ);
  const curAllow = new Set((cur.stage.sources || []).map((s) => String(s.url).replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '').toLowerCase()));
  check('current: search returned results', (cur.stage.sources || []).length > 0, JSON.stringify(cur.stage.metadata?.webSearch));
  check('current: no URLs outside the search results', urlsIn(cur.content).every((u) => curAllow.has(u.replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '').toLowerCase())), JSON.stringify(urlsIn(cur.content)));
  check('current: produced an answer', cur.content.trim().length > 0, cur.content.slice(0, 120));

  console.log('\n[11] live: a current question with no useful results does not invent facts');
  const ghostQ = 'exact current population in 2026 of the invented settlement Zzorbledorf-on-Sea';
  const ghost = await runSelf(ghostQ);
  check('ghost: no fabricated URL', urlsIn(ghost.content).length === 0, JSON.stringify(urlsIn(ghost.content)));
  const ghostNumbers = (ghost.content.match(/\b\d[\d,]*\b/g) || []).filter((n) => n.replace(/[,\s]/g, '') !== '2026');
  check('ghost: no fabricated population number', ghostNumbers.filter((n) => n.length >= 3).length === 0, JSON.stringify(ghostNumbers));
  check('ghost: states the data is unavailable', /(not a real|fictional|invented|no verifiable|unavailable|cannot|no reliable|not found|does not exist|doesn'?t exist)/i.test(ghost.content), ghost.content.slice(0, 240));
  check('ghost: no ugly internal code phrase leak', !/required evidence|grounding|searchPlanner|prompt/i.test(ghost.content), ghost.content.slice(0, 240));

  console.log('\n[12] live: a self question after a previous topic is not contaminated');
  const priorTopic = 'the movie Zorblax Rising (2026)';
  const history = [
    { role: 'user', content: `Tell me about ${priorTopic}` },
    { role: 'assistant', content: 'Zorblax Rising is a 2026 science-fiction film.' },
  ];
  const selfQuery = await resolveSearchQuery({ content: 'tell me about yourself', history });
  console.log(`   · self query after topic: ${JSON.stringify(selfQuery)}`);
  check('unrelated self question does not inherit the prior subject', !lower(selfQuery).includes('zorblax'), selfQuery);
  const selfAfter = await runSelf('tell me about yourself', history);
  check('unrelated self answer is not about the prior subject', !lower(selfAfter.content).includes('zorblax rising'), selfAfter.content.slice(0, 200));
  check('unrelated self answer has no ugly disclaimer', !hasUgly(selfAfter.content), selfAfter.content.slice(0, 200));

  console.log('\n[13] live: a genuine follow-up still keeps the previous subject');
  const followQuery = await resolveSearchQuery({ content: 'give me the trailer', history });
  console.log(`   · follow-up query: ${JSON.stringify(followQuery)}`);
  check('follow-up query carries the prior subject', lower(followQuery).includes('zorblax'), followQuery);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed${LIVE ? '' : ' (deterministic-only)'}`);
process.exit(fail > 0 ? 1 : 0);
