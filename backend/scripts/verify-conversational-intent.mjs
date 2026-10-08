// Dynamic verification for the social/ritual-message path.
//
//   node scripts/verify-conversational-intent.mjs
//
// Proves that greeting-class messages (hi, hello, good morning, thanks ...)
// skip the universal web-search stage and get a brief conversational reply
// with no sources, no citations, no links and no resource card - while every
// message containing a content word (informational questions, identity
// probes, contextual follow-ups, explicit resource requests) still takes the
// existing universal search path with its planner, grounding and
// resource-card guarantees.

import { runWebSearchStage } from '../src/controllers/chatController.js';
import { isConversationalMessage } from '../src/services/conversationIntent.js';
import { buildResource } from '../src/services/resourceCard.js';
import { buildSearchContext, buildUrlAllowlist } from '../src/services/webSearchService.js';
import { processMessage } from '../src/services/aiService.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`FAIL   ${name}${detail ? ` :: ${detail}` : ''}`); }
};

const extractUrls = (text) => String(text || '').match(/https?:\/\/[^\s<>"'`]+/g) || [];
const CITES = /\[\d{1,2}\]/;
const urlKey = (u) => String(u || '').toLowerCase().replace(/[)\].,;:!?'"]+$/, '').replace(/\/+$/, '');

const assertBriefConversation = (label, text) => {
  check(`${label}: produced an answer`, String(text || '').trim().length > 0);
  check(`${label}: brief (no long informational answer)`, String(text || '').length < 800, `len=${String(text || '').length}`);
  check(`${label}: no URLs / links`, extractUrls(text).length === 0, JSON.stringify(extractUrls(text)));
  check(`${label}: no [n] citations`, !CITES.test(String(text || '')), String(text || '').slice(0, 200));
  check(`${label}: no ::RESOURCE block`, !String(text || '').includes('::RESOURCE'));
};

// ---------------------------------------------------------------------------
console.log('\n[0] classifier: greetings and equivalent social messages are conversational');
const social = [
  'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening',
  'good night', 'thanks', 'thank you', 'bye', 'how are you?', "what's up?",
  'hi everyone', 'thanks a lot', 'thank you so much', 'see you later',
  'good morning!', 'thanks for everything', 'ok', 'are you ok?',
  'nice to meet you', 'take care', 'hi, how are you?', '👋', 'hi 👋', '🎉',
];
for (const s of social) {
  check(`social: ${JSON.stringify(s)}`, isConversationalMessage(s) === true);
}

// ---------------------------------------------------------------------------
console.log('\n[1] classifier: information requests and follow-ups still search');
const informational = [
  'What is quantum computing?',
  'Who is the current Prime Minister of India?',
  'who are you?',
  'what can you do?',
  'how do you work?',
  'tell me about yourself',
  'how?',
  'hi, what is quantum computing?',
  'hello, can you search for the latest news?',
  'Explain the latest AI news',
  'Give me the trailer for Dune',
  'Find the official website of NASA',
  'what happened today?',
  'give me a reliable link about it',
  'is it new?',
  'open youtube',
  'आज का समाचार बताओ',
];
for (const s of informational) {
  check(`informational: ${JSON.stringify(s)}`, isConversationalMessage(s) === false);
}
check('empty input is not conversational (existing empty path unchanged)', isConversationalMessage('') === false);

// ---------------------------------------------------------------------------
console.log('\n[2] search stage: greetings skip the stage entirely (no query, no sources)');
for (const s of ['hi', 'hello', 'good morning', 'thanks']) {
  const stage = await runWebSearchStage(s, [{ role: 'user', content: 'hi' }]);
  console.log(`   · ${JSON.stringify(s)}: type=${stage.type}`);
  check(`${JSON.stringify(s)} -> none`, stage.type === 'none', JSON.stringify(stage));
  check(`${JSON.stringify(s)}: no webSearch metadata`, !stage.metadata?.webSearch);
}
// A greeting in the middle of a technical conversation behaves the same.
const midStage = await runWebSearchStage('thanks', [
  { role: 'user', content: 'Explain the latest AI news' },
  { role: 'assistant', content: '...' },
]);
check('greeting after a technical turn -> still none', midStage.type === 'none', JSON.stringify(midStage));
// Attachment-only / empty messages keep their existing behaviour.
check('empty message -> none', (await runWebSearchStage('', [])).type === 'none');

// ---------------------------------------------------------------------------
console.log('\n[3] search stage: arbitrary informational questions still search (live)');
const infoStage = await runWebSearchStage('Who is the current Prime Minister of India?', []);
console.log(`   · type=${infoStage.type} sources=${infoStage.metadata?.webSearch?.sources?.length ?? 0}`);
check('informational question -> search', infoStage.type === 'search', JSON.stringify(infoStage.type));
check('search returned sources', (infoStage.metadata?.webSearch?.sources || []).length > 0);

// ---------------------------------------------------------------------------
console.log('\n[4] greeting end-to-end (non-streaming): brief, uncited, no card');
const greet = 'good morning';
const messages4 = [{ role: 'user', content: greet }];
const plain4 = await processMessage({ messages: messages4, userContent: greet, stream: false, webSearch: null });
console.log(`   · reply: ${JSON.stringify(String(plain4.content || '').slice(0, 160))}`);
assertBriefConversation('plain', plain4.content);
check('plain: no webSearch metadata', !plain4.metadata?.webSearch, JSON.stringify(plain4.metadata));
check('plain: no resource card', !plain4.metadata?.resource, JSON.stringify(plain4.metadata?.resource));

// ---------------------------------------------------------------------------
console.log('\n[5] greeting end-to-end (streaming): parity with non-streaming');
const gen5 = await processMessage({ messages: messages4, userContent: greet, stream: true, webSearch: null });
let streamed5 = '';
for await (const chunk of gen5) streamed5 += chunk;
const resource5 = await gen5.resource;
console.log(`   · reply: ${JSON.stringify(streamed5.slice(0, 160))}`);
assertBriefConversation('stream', streamed5);
check('stream: resource promise resolves null', resource5 == null, JSON.stringify(resource5));

// ---------------------------------------------------------------------------
console.log('\n[6] explicit resource request: searches, card only from search evidence');
const trailerReq = 'Give me the official trailer for the movie Parasite';
const stage6 = await runWebSearchStage(trailerReq, []);
console.log(`   · type=${stage6.type} sources=${stage6.metadata?.webSearch?.sources?.length ?? 0}`);
check('resource request -> search', stage6.type === 'search', JSON.stringify(stage6.type));
check('resource request returned sources', (stage6.metadata?.webSearch?.sources || []).length > 0);
const sources6 = stage6.metadata?.webSearch?.sources || [];
const allow6 = buildUrlAllowlist(sources6);

// Deterministic card contract: fabricated link dies, evidence link builds.
const fabricated = buildResource({
  raw: JSON.stringify({ type: 'video', title: 'Parasite official trailer', primaryLink: 'https://youtube.com/watch?v=AAAAAAAAAAA' }),
  sources: sources6,
  images: [],
});
check('fabricated card link is rejected', fabricated == null, JSON.stringify(fabricated));
const evidenceUrl = sources6[0]?.url || '';
const grounded = evidenceUrl ? buildResource({
  raw: JSON.stringify({ type: 'video', title: sources6[0].title || 'result', primaryLink: evidenceUrl }),
  sources: sources6,
  images: [],
}) : null;
check('search-evidence link builds a card', !evidenceUrl || (grounded && grounded.primaryLink === evidenceUrl), JSON.stringify(grounded));

// Live model behaviour: any card must come from the search results.
if (sources6.length > 0) {
  const plain6 = await processMessage({
    messages: [{ role: 'user', content: trailerReq }],
    userContent: trailerReq,
    stream: false,
    webSearch: { text: buildSearchContext(sources6), sources: sources6 },
  });
  const card6 = plain6.metadata?.resource;
  console.log(`   · card: ${card6 ? JSON.stringify({ type: card6.type, primaryLink: card6.primaryLink }) : 'none'}`);
  check('no raw ::RESOURCE marker in prose', !String(plain6.content || '').includes('::RESOURCE'));
  if (card6) {
    check('card link came from the search results', allow6.has(urlKey(card6.primaryLink)), card6.primaryLink);
    check('no URLs outside the search results', extractUrls(plain6.content).every((u) => allow6.has(urlKey(u))), JSON.stringify(extractUrls(plain6.content)));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
