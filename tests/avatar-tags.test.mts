import test from 'node:test';
import assert from 'node:assert/strict';
import { stripAvatarTags, hidePartialAvatarTag, splitAvatarTags, protectAvatarTags } from '../web/src/avatar-tags.js';
import { speechChunks } from '../web/src/voice.js';

test('known emotions and gestures are stripped, spacing tidied', () => {
  assert.equal(stripAvatarTags('[happy] Sure!'), 'Sure!');
  assert.equal(stripAvatarTags('[wave] See you.'), 'See you.');
  assert.equal(stripAvatarTags('[HAPPY] hi'), 'hi');
  assert.equal(stripAvatarTags('[happy] hi [wave] bye'), 'hi bye');
  assert.equal(stripAvatarTags('a  [happy]  b'), 'a b');
});

test('prefixed tags need a value; bare ones and unknown names are kept', () => {
  assert.equal(stripAvatarTags('[pose:horse] I can do it.'), 'I can do it.');
  assert.equal(stripAvatarTags('[expr:HeartEyes:0.6] hi'), 'hi');
  assert.equal(stripAvatarTags('[pose] I will show you'), '[pose] I will show you');
  assert.equal(stripAvatarTags('[1] first item'), '[1] first item');
  assert.equal(stripAvatarTags('[sic] the word'), '[sic] the word');
  assert.equal(stripAvatarTags('[expr:Heart Eyes] hi'), '[expr:Heart Eyes] hi');
  assert.equal(stripAvatarTags('[pose:' + 'x'.repeat(45) + '] hi'), '[pose:' + 'x'.repeat(45) + '] hi');
});

// The voice model invents prefixes — [kick:highkick], [block:block] — where the
// vocabulary only has [pose:...]. Those are stripped from TTS here; the avatar
// re-maps them to poses itself (TAG_ALIAS in avatar-app.js).
test('invented [word:value] prefixes are stripped from TTS', () => {
  assert.equal(stripAvatarTags('[kick:highkick] Here is my high kick!'), 'Here is my high kick!');
  assert.equal(stripAvatarTags('[block:block] Here is my strong block!'), 'Here is my strong block!');
  assert.equal(stripAvatarTags('[block:kneeblock] And finish!'), 'And finish!');
  // cues keep every bracket for the avatar to interpret
  const s = splitAvatarTags('[kick:highkick] Here is my high kick!');
  assert.equal(s.cues, '[kick:highkick] Here is my high kick!');
});

test('emoji never reach TTS (Kokoro would read them by name)', () => {
  assert.equal(stripAvatarTags('Here is my strong block! \u{1F4A5}'), 'Here is my strong block!');
  assert.equal(stripAvatarTags('Here is my high kick! \u{1F94A}\u{1F4A5}'), 'Here is my high kick!');
  assert.equal(stripAvatarTags('\u{1F483}\u{1F57A}'), ''); // woman+man dancing -> nothing
  assert.equal(stripAvatarTags('[pose:ready] Ready stance \u{1F4AA}'), 'Ready stance');
  assert.equal(stripAvatarTags('A \u{1F1FA}\u{1F1F8} flag here'), 'A flag here');
});

test('mid-sentence tags are removed without breaking the sentence', () => {
  assert.equal(stripAvatarTags('Here is the plan [nod] and the next step'), 'Here is the plan and the next step');
  assert.equal(stripAvatarTags('First thing [wave] second thing'), 'First thing second thing');
});

test('speech cues (laugh)/(sigh)/... are not avatar tags: they pass to TTS', () => {
  assert.equal(stripAvatarTags('(laugh) hello'), '(laugh) hello');
  assert.equal(stripAvatarTags('Goodbye (sigh)'), 'Goodbye (sigh)');
});

test('a trailing partial that could still become a tag is hidden; a complete non-tag is shown', () => {
  assert.equal(hidePartialAvatarTag('Sure, [hap'), 'Sure, ');
  assert.equal(hidePartialAvatarTag('see you [wa'), 'see you ');
  assert.equal(hidePartialAvatarTag('[sick]'), '[sick]');
  assert.equal(hidePartialAvatarTag('[sic]'), '[sic]');
});

test('splitAvatarTags: TTS gets the sentence without tags, cues keep them for the avatar', () => {
  const s = splitAvatarTags('[happy] hi (sigh) there');
  assert.equal(s.spoken, 'hi (sigh) there');
  assert.equal(s.cues, '[happy] hi (sigh) there');

  const mid = splitAvatarTags('First thing [wave] second thing');
  assert.equal(mid.spoken, 'First thing second thing');
  assert.equal(mid.cues, 'First thing [wave] second thing');

  // A sentence that is only cues still delivers its cues (the avatar reacts, nothing is spoken).
  const cueOnly = splitAvatarTags('[giggle]');
  assert.equal(cueOnly.spoken, '');
  assert.equal(cueOnly.cues, '[giggle]');
});

test('protectAvatarTags: underscored exercise tags survive cleanup, unknown brackets are left alone', () => {
  const { guarded, restore } = protectAvatarTags('[exercise:deep_squat:2] Do the _squats_ now [1] and [sic] more [pose:horse].');
  // PUA token is a single BMP code unit, never a stripped char; unknown [1]/[sic] are left alone.
  assert.equal(guarded, '\uE000 Do the _squats_ now [1] and [sic] more \uE001.');
  assert.equal(restore(guarded), '[exercise:deep_squat:2] Do the _squats_ now [1] and [sic] more [pose:horse].');
  // The full voice pipeline: protect -> speechChunks cleanup -> splitAvatarTags on the restored text.
  const guardedLong = protectAvatarTags('[exercise:side_lunge:2] and again [exercise:side_lunge:2]');
  const cleaned = speechChunks(guardedLong.guarded).join(' ');
  const { cues } = splitAvatarTags(guardedLong.restore(cleaned));
  const ex = [...cues.matchAll(/\[exercise:([^\]:]+):/g)].map(m => m[1]);
  assert.deepEqual(ex, ['side_lunge', 'side_lunge']);
  assert.equal([...new Set(guardedLong.guarded.match(/[\uE000-\uF8FF]/g) || [])].length, 1);
});

// A real LLM reply (from the 2026-10-03 voice session): three moves in one
// sentence, the middle two using invented prefixes, decorated with emoji.
test('real karate reply: all three moves survive as cues, TTS hears only words', () => {
  const reply = '[pose:ready] Here is my ready stance! [kick:highkick] Now let\'s perform a high kick! [block:block] And finish with a strong block! \u{1F94A}\u{1F4A5}';
  const s = splitAvatarTags(reply);
  assert.equal(s.spoken, 'Here is my ready stance! Now let\'s perform a high kick! And finish with a strong block!');
  const found = [...s.cues.matchAll(/\[([a-z]+):([a-z]+)\]/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(found, [['pose', 'ready'], ['kick', 'highkick'], ['block', 'block']]);
});

test('plain text is untouched', () => {
  assert.equal(stripAvatarTags('Just a normal sentence.'), 'Just a normal sentence.');
});
