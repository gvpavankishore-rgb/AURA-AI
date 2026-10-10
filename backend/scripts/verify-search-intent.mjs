// Deterministic verification for smart web-search intent detection.
//
//   node scripts/verify-search-intent.mjs
//
// Proves the behaviour the product requires, using mocked AI/search (the only
// stand-in is the `ask` completion injected into the resolver) so the run is
// stable and offline:
//
//   * each message is classified on its own - recent search history never
//     forces a search and never suppresses one;
//   * a greeting after a factual question is small talk (no search);
//   * a greeting mixed with a factual question ("Hey, what are the latest AI
//     tools?") still searches;
//   * typos / abbreviations / foreign greetings are classified by meaning;
//   * casual messages with ambiguous wording ("that's cool", "lol") do not
//     search, while explicit news/sources/website requests do;
//   * the same stage decision feeds both the streaming and the non-streaming
//     path.

import { getSystemPrompt } from '../src/services/aiService.js';
import { runWebSearchStage } from '../src/controllers/chatController.js';
import {
  isConversationalMessage,
  isConfidentInformation,
} from '../src/services/conversationIntent.js';
import {
  parseResolution,
  resolveSearchIntent,
  planSearch,
} from '../src/services/searchPlanner.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`FAIL   ${name}${detail ? ` :: ${detail}` : ''}`); }
};

// A deterministic stand-in for the resolver's model call. `reply` may be a
// string or a function of the prompt (so one fake can answer several cases).
const askReturning = (reply) => async ({ prompt }) => (typeof reply === 'function' ? reply(prompt) : reply);

// ---------------------------------------------------------------------------
console.log('\n[0] deterministic safety net: a casual opener cannot hide a real question');
const confidentInfo = [
  'Hey, what are the latest AI tools?',
  'Hello, who is the current Prime Minister of India?',
  'hi, what is the population of France?',
  'https://example.com - summarise this',
  'Who is the current PM of India?',
];
for (const s of confidentInfo) {
  check(`confident information: ${JSON.stringify(s)}`, isConfidentInformation(s) === true);
}
const notConfident = ['how are you?', 'that\'s cool', 'lol', 'sounds good thanks', 'i\'m good', 'what?'];
for (const s of notConfident) {
  check(`not confident information: ${JSON.stringify(s)}`, isConfidentInformation(s) === false);
}

// ---------------------------------------------------------------------------
console.log('\n[1] resolver parsing: CHAT / CLARIFY / query');
check('CHAT: -> chat verdict', parseResolution('CHAT:')?.chat === true);
check('lowercase chat : -> chat verdict', parseResolution('chat :')?.chat === true);
check('query text -> query', parseResolution('capital of france population')?.query === 'capital of france population');
check('CLARIFY: -> clarification', Boolean(parseResolution('CLARIFY: which country?')?.clarification));
check('empty -> null', parseResolution('') === null);

// ---------------------------------------------------------------------------
console.log('\n[2] resolver (mocked): factual searches, small talk skips');
const factual = await resolveSearchIntent({
  content: 'wh is the captial of frnace and wht is its populaton?',
  ask: askReturning('capital of France population'),
});
check('typo factual -> corrected query', factual.query === 'capital of France population' && factual.chat === false, JSON.stringify(factual));

const chitChat = ['Hi', 'How are you?', "that's cool", 'lol nice one', 'sounds good, thanks', "i'm good", 'haha ok'];
for (const s of chitChat) {
  const r = await resolveSearchIntent({ content: s, ask: askReturning('CHAT:') });
  check(`small talk -> chat: ${JSON.stringify(s)}`, r.chat === true && r.query === '', JSON.stringify(r));
}

const mixed = await resolveSearchIntent({
  content: 'Hey, what are the latest AI tools?',
  ask: askReturning('CHAT:'),
});
check('greeting + factual overrides a wrong chat verdict', mixed.chat === false && mixed.query.length > 0, JSON.stringify(mixed));

// "New standalone message": a fresh greeting must not inherit the previous
// topic, and a fresh question must not be suppressed by search history.
const history = [
  { role: 'user', content: 'Explain the latest AI news' },
  { role: 'assistant', content: 'Here is a summary of recent AI news...' },
];
const freshGreeting = await resolveSearchIntent({ content: 'thanks', history, ask: askReturning('CHAT:') });
check('greeting after a factual turn -> chat (history does not force a search)', freshGreeting.chat === true, JSON.stringify(freshGreeting));
const freshQuestion = await resolveSearchIntent({
  content: 'What is the capital of France?',
  history,
  ask: askReturning('capital of France'),
});
check('standalone question after history -> searches its own subject', freshQuestion.query === 'capital of France' && freshQuestion.chat === false, JSON.stringify(freshQuestion));

// No-AI fallback stays context-aware and never returns chat.
const noAi = await resolveSearchIntent({
  content: 'what about the price?',
  history: [{ role: 'user', content: 'Tell me about the iPhone 16' }],
  ask: async () => null,
});
check('no-AI fallback keeps earlier subject', /iphone/i.test(noAi.query) && noAi.chat === false, JSON.stringify(noAi));

// ---------------------------------------------------------------------------
console.log('\n[3] planner routing (mocked search + evaluate): chat never searches');
const makeSearch = () => {
  const calls = [];
  const search = async (q) => { calls.push(q); return { enabled: true, results: [{ title: 'r', url: 'https://e.com', content: 'c' }] }; };
  return { calls, search };
};
const keepAll = async ({ results }) => ({ kept: results, refinedQuery: null, skipped: false });

const search1 = makeSearch();
const chatPlan = await planSearch({
  content: 'that\'s cool',
  resolve: async () => ({ query: '', clarification: null, chat: true }),
  search: search1.search,
  evaluate: keepAll,
});
check('chat plan -> status chat', chatPlan.status === 'chat', JSON.stringify(chatPlan));
check('chat plan never calls search', search1.calls.length === 0, JSON.stringify(search1.calls));

const search2 = makeSearch();
const infoPlan = await planSearch({
  content: 'Who is the current PM of India?',
  resolve: async () => ({ query: 'current Prime Minister of India', clarification: null, chat: false }),
  search: search2.search,
  evaluate: keepAll,
});
check('information plan -> status ok', infoPlan.status === 'ok', JSON.stringify(infoPlan));
check('information plan calls search once with the resolved query', search2.calls.length === 1 && search2.calls[0] === 'current Prime Minister of India', JSON.stringify(search2.calls));

let resolveSawHistory = null;
const search3 = makeSearch();
await planSearch({
  content: 'What about his latest schemes?',
  history: [{ role: 'user', content: 'Narendra Modi' }],
  resolve: async ({ content, history }) => {
    resolveSawHistory = history;
    return { query: 'Narendra Modi latest government schemes', clarification: null, chat: false };
  },
  search: search3.search,
  evaluate: keepAll,
});
check('contextual follow-up: resolver received the conversation history', Array.isArray(resolveSawHistory) && resolveSawHistory[0]?.content === 'Narendra Modi', JSON.stringify(resolveSawHistory));

// ---------------------------------------------------------------------------
console.log('\n[4] controller stage: chat skips the web stage, info keeps it');
let plannerCalls = 0;
const spyPlanner = async ({ content }) => {
  plannerCalls += 1;
  return { status: 'ok', query: 'q', sources: [{ title: 't', url: 'https://e.com', content: 'c' }], images: [] };
};
const hiStage = await runWebSearchStage('hello', [], spyPlanner);
check('deterministic greeting -> none, planner not called', hiStage.type === 'none' && plannerCalls === 0, JSON.stringify(hiStage));

const modelChatStage = await runWebSearchStage('that\'s cool', [], async () => ({ status: 'chat', query: '' }));
check('model-classified chat -> none + conversational flag', modelChatStage.type === 'none' && modelChatStage.conversational === true, JSON.stringify(modelChatStage));

const infoStage = await runWebSearchStage('Who is the current PM of India?', [], spyPlanner);
check('information -> search stage', infoStage.type === 'search' && infoStage.sources.length === 1, JSON.stringify(infoStage.type));

const clarifyStage = await runWebSearchStage('which one?', [], async () => ({ status: 'clarify', query: '', clarification: 'Which one do you mean?' }));
check('clarify -> static question', clarifyStage.type === 'static' && /Which one/.test(clarifyStage.content), JSON.stringify(clarifyStage));

// ---------------------------------------------------------------------------
console.log('\n[5] streaming / non-streaming parity');
check('conversational stage carries a flag both paths forward', modelChatStage.conversational === true);
const convPrompt = getSystemPrompt({ conversational: true });
const normalPrompt = getSystemPrompt({ conversational: false });
check('conversational flag selects the brief social register', /purely social/.test(convPrompt));
check('default prompt is not forced conversational', !/purely social/.test(normalPrompt));

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
