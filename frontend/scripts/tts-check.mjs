import { createTtsSpeaker, STATE, chunkText, stripForSpeech } from '../src/utils/ttsController.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ok - ${msg}`);
  else { failures += 1; console.error(`  FAIL - ${msg}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, timeoutMs = 10000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await wait(stepMs);
  }
  return false;
}

// Fake native speechSynthesis driven by a timer. NOTE on Windows, setInterval
// is clamped to ~15.6ms per tick regardless of tickMs, so the fake advances a
// whole CHUNK_STEP of chars per tick instead of relying on wall-clock speed.
const CHUNK_STEP = 40;

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.voice = null;
    this.lang = '';
    this.rate = 1;
    this.pitch = 1;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

const createFakeSynth = ({ tickMs = 1, charStep = CHUNK_STEP, silentAfterTicks = null } = {}) => {
  const utts = { current: null, canceled: [], started: [] };
  let paused = false;
  let silent = false;
  let progressedTicks = 0;
  let resumeCalls = 0;
  let iv = null;

  const synth = {
    get speaking() { return utts.current !== null; },
    get paused() { return paused; },
    speak(u) {
      if (utts.current) throw new Error('fake: speak while already speaking');
      u._position = 0;
      u._duration = u.text.length;
      u._index = utts.started.length;
      utts.current = u;
      utts.started.push(u);
      paused = false;
      silent = false;
      progressedTicks = 0;
      if (u.onstart) u.onstart();
    },
    pause() {
      if (utts.current) paused = true;
    },
    resume() {
      paused = false;
      silent = false;
      progressedTicks = 0;
      resumeCalls += 1;
    },
    cancel() {
      const cur = utts.current;
      utts.current = null;
      paused = false;
      silent = false;
      progressedTicks = 0;
      if (cur) {
        utts.canceled.push(cur);
        if (cur.onerror) cur.onerror({ error: 'canceled' });
      }
    },
    _tick() {
      const u = utts.current;
      if (!u) return;
      if (silentAfterTicks != null && progressedTicks >= silentAfterTicks) silent = true;
      if (paused || silent) return;
      u._position += charStep;
      progressedTicks += 1;
      if (u._position >= u._duration) {
        utts.current = null;
        progressedTicks = 0;
        if (u.onend) u.onend();
      }
    },
  };
  iv = setInterval(() => synth._tick(), tickMs);
  return {
    synth,
    utts,
    get resumeCalls() { return resumeCalls; },
    stopTicking() { clearInterval(iv); },
  };
};

const makeSpeaker = (synth, attrs = {}) => {
  const states = new Map();
  const speaker = createTtsSpeaker({
    speechSynthesis: synth,
    createUtterance: (t) => new FakeUtterance(t),
    onState: (id, st, err) => states.set(id, { state: st, error: err }),
    firstSpeakDelayMs: 0,
    resyncIntervalMs: 0,
    ...attrs,
  });
  return { states, speaker };
};

// Total spoken progress across all utterances (ended chunks keep their final
// position, the live chunk counts its current position). If playback ever
// restarted, this total would drop — a forward jump proves continuation.
const totalProgress = (utts) =>
  utts.started.reduce((sum, u) => sum + Math.min(u._position ?? 0, u._duration), 0);

console.log('== Text cleanup (markdown / code / urls / json) ==');
assert(stripForSpeech('**Java** is **powerful**.') === 'Java is powerful.', 'bold markdown spoken as plain text');
assert(stripForSpeech('# Heading\nSecond line.') === 'Heading Second line.', 'heading markers removed');
assert(stripForSpeech('```js\nconst a = 1;\n```\nReal answer.').includes('```') === false, 'code fences removed');
assert(stripForSpeech('See https://example.com/x for details.').includes('http') === false, 'URLs removed');
assert(
  stripForSpeech('{ "role": "assistant", "content": "x" }').startsWith('The response contains structured data'),
  'raw JSON summarized instead of read aloud'
);

console.log('== Chunking (long responses) ==');
const longText = 'Java is an object-oriented programming language. It features classes, inheritance, polymorphism, encapsulation and more. '.repeat(40);
const cleaned = stripForSpeech(longText);
const chunks = chunkText(cleaned);
assert(chunks.length > 3, `long text split into ${chunks.length} chunks`);
assert(chunks.every((c) => c.length <= 200), 'every chunk stays within the 200-char limit');
assert(chunks.join(' ').replace(/\s+/g, ' ') === cleaned.replace(/\s+/g, ' '), 'chunks reconstruct the full source text');

console.log('== Scenario: Play -> Pause -> Play(resume) -> Pause -> Resume -> finish ==');
{
  const fake = createFakeSynth();
  const { states, speaker } = makeSpeaker(fake.synth);
  const msgId = 'A';

  speaker.toggle(msgId, longText, STATE.IDLE);
  assert(states.get(msgId)?.state === STATE.PLAYING, '1. Play starts: PLAYING');
  await wait(30);

  const firstUtt = fake.utts.current;
  const halfway = firstUtt._duration * 0.25;
  const mastered = await until(() => fake.utts.current === firstUtt && firstUtt._position >= halfway);
  assert(mastered, 'speech advanced partway through the first chunk');

  speaker.toggle(msgId, longText, STATE.PLAYING);
  assert(states.get(msgId)?.state === STATE.PAUSED, '2. Pause: state PAUSED');
  assert(fake.synth.paused === true, 'underlying speechSynthesis.pause() was used (no cancel)');
  const pausePos = firstUtt._position;
  assert(pausePos > 0 && pausePos < firstUtt._duration, 'paused mid-utterance, not at the start');

  await wait(50);
  assert(firstUtt._position === pausePos, 'position is frozen while paused (does not drift, does not restart)');
  assert(fake.utts.canceled.indexOf(firstUtt) === -1, 'pause did NOT cancel the utterance');

  speaker.toggle(msgId, longText, STATE.PAUSED);
  assert(states.get(msgId)?.state === STATE.PLAYING, '3. Play again (resume): state PLAYING');
  assert(fake.synth.paused === false, 'speechSynthesis.resume() was called');
  assert(fake.utts.current === firstUtt && firstUtt._position === pausePos, 'the SAME utterance resumes from the saved position');
  const progressAtResume = totalProgress(fake.utts);

  await wait(40);
  assert(totalProgress(fake.utts) > progressAtResume, 'speech continues from paused position, NOT from the beginning');

  const liveBeforePause2 = fake.utts.current;
  const pause2Pos = liveBeforePause2._position;
  speaker.toggle(msgId, longText, STATE.PLAYING);
  assert(states.get(msgId)?.state === STATE.PAUSED, '4. Pause again: PAUSED');
  const progressAtPause2 = totalProgress(fake.utts);

  speaker.toggle(msgId, longText, STATE.PAUSED);
  assert(states.get(msgId)?.state === STATE.PLAYING, '5. Resume again: PLAYING');
  assert(fake.utts.current === liveBeforePause2 && liveBeforePause2._position === pause2Pos, 'second resume preserves the same live utterance position');
  await wait(40);
  assert(totalProgress(fake.utts) > progressAtPause2, 'second resume continued from its paused position');

  const finished = await until(() => states.get(msgId)?.state === STATE.IDLE);
  assert(finished, '6. let it finish: state returns to IDLE (Play button)');
  assert(fake.utts.started.length === chunks.length, `entire response read once (${fake.utts.started.length}/${chunks.length} chunks), no repeats`);

  speaker.stop();
  fake.stopTicking();
}

console.log('== Scenario: Message A playing -> Play Message B (only one speaks) ==');
{
  const fake = createFakeSynth();
  const { states, speaker } = makeSpeaker(fake.synth);

  speaker.toggle('A', 'This is the content of message A. '.repeat(60), STATE.IDLE);
  await wait(30);
  const aUtt = fake.utts.current;
  assert(aUtt !== null && states.get('A')?.state === STATE.PLAYING, 'A is playing');

  speaker.toggle('B', 'This is the content of message B. '.repeat(60), STATE.IDLE);
  await wait(30);
  assert(states.get('B')?.state === STATE.PLAYING, 'B starts PLAYING');
  assert(fake.utts.current !== null && fake.utts.current !== aUtt, 'B speaks its own utterance');
  assert(fake.utts.canceled.includes(aUtt), 'A was canceled when B started');

  await wait(60);
  assert(fake.utts.current !== aUtt, 'A never resumes while B plays');
  assert(fake.utts.started.filter((u) => u === aUtt).length === 1, 'A started exactly once');

  speaker.stop();
  fake.stopTicking();
}

console.log('== Scenario: Chrome silent-pause bug + user-paused guard ==');
{
  const fake = createFakeSynth({ silentAfterTicks: 2 });
  const { states, speaker } = makeSpeaker(fake.synth, { resyncIntervalMs: 25 });

  const text = 'This chunk is long enough to trigger the silent pause bug workaround. '.repeat(20);
  speaker.toggle('A', text, STATE.IDLE);
  await wait(30);

  const resumeAtPause = fake.resumeCalls;
  speaker.toggle('A', text, STATE.PLAYING);
  assert(states.get('A')?.state === STATE.PAUSED, 'state PAUSED while user paused');
  await wait(80);
  assert(states.get('A')?.state === STATE.PAUSED, 'stays PAUSED');
  assert(fake.resumeCalls === resumeAtPause, 'resync guard does NOT fight a user-initiated pause');

  speaker.toggle('A', text, STATE.PAUSED);
  const finished = await until(() => states.get('A')?.state === STATE.IDLE, 10000);
  assert(finished, 'long chunk still completes in a real browser via the resync guard');

  speaker.stop();
  fake.stopTicking();
}

console.log('');
if (failures === 0) {
  console.log('ALL TTS CHECKS PASSED');
  process.exit(0);
} else {
  console.log(`${failures} TTS CHECK(S) FAILED`);
  process.exit(1);
}