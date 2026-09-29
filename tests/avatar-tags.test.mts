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


test('plain text is untouched', () => {
  assert.equal(stripAvatarTags('Just a normal sentence.'), 'Just a normal sentence.');
});
