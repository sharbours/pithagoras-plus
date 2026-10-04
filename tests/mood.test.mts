import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOODS,
  MOOD_KEYS,
  isMoodKey,
  moodBlock,
  applyMood,
} from '../server/src/pi/mood.js';

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test('exposes the four moods the selector shows', () => {
  assert.deepEqual(
    MOOD_KEYS,
    ['default', 'helpful', 'playful', 'teacher'],
    'MOOD_KEYS must list every mood in display order',
  );
  assert.equal(MOODS.default.label, 'Default');
  assert.equal(MOODS.helpful.label, 'Helpful');
  assert.equal(MOODS.playful.label, 'Playful insults');
  assert.equal(MOODS.teacher.label, 'Teacher');
  // Non-default moods each carry a persona block; the default does not.
  for (const key of MOOD_KEYS) {
    if (key === 'default') {
      assert.equal(MOODS[key].block, null);
    } else {
      assert.ok(MOODS[key].block, `${key} must have a block`);
      assert.ok(MOODS[key].block.length > 20, `${key} block should be substantive`);
    }
  }
});

test('isMoodKey accepts exactly the catalogue keys', () => {
  assert.equal(isMoodKey('default'), true);
  assert.equal(isMoodKey('helpful'), true);
  assert.equal(isMoodKey('playful'), true);
  assert.equal(isMoodKey('teacher'), true);
  // Unknown strings are rejected — the route falls these back to "default"
  // rather than trusting arbitrary text to end up in a prompt.
  assert.equal(isMoodKey('boss'), false);
  assert.equal(isMoodKey(''), false);
  assert.equal(isMoodKey(null), false);
  assert.equal(isMoodKey(undefined), false);
  assert.equal(isMoodKey(7), false);
  assert.equal(isMoodKey({ key: 'helpful' }), false);
});

// ---------------------------------------------------------------------------
// moodBlock
// ---------------------------------------------------------------------------

test('moodBlock returns "" for no mood and the block text otherwise', () => {
  assert.equal(moodBlock(null), '');
  assert.equal(moodBlock(undefined), '');
  assert.equal(moodBlock(''), '');
  assert.equal(moodBlock('default'), '', 'default is the no-mood state');
  assert.equal(moodBlock('helpful'), MOODS.helpful.block);
  assert.equal(moodBlock('playful'), MOODS.playful.block);
  assert.equal(moodBlock('teacher'), MOODS.teacher.block);
  // Unknown keys are treated as no mood — never a fabricated persona.
  assert.equal(moodBlock('bogus'), '');
});

// ---------------------------------------------------------------------------
// applyMood — the per-message injection
// ---------------------------------------------------------------------------

test('applyMood is a no-op for no mood (byte-identical to pre-feature)', () => {
  const msg = 'hello, what is 2+2?';
  for (const none of [null, undefined, '', 'default']) {
    assert.equal(applyMood(msg, none), msg);
  }
});

test('applyMood prepends a <mood> block carrying the persona', () => {
  for (const key of ['helpful', 'playful', 'teacher'] as const) {
    const out = applyMood('what is the capital of France?', key);
    assert.equal(
      out,
      `<mood>\n${MOODS[key].block}\n</mood>\n\nwhat is the capital of France?`,
    );
  }
});

test('applyMood puts the persona BEFORE the user words, not after', () => {
  // The model should read the persona first, then the message — a block after
  // the words would compete with them for the model's attention.
  const out = applyMood('hi', 'teacher');
  assert.ok(out.indexOf(MOODS.teacher.block) < out.indexOf('hi'));
});

test('the mood block is not confused with the voice [Audio mode] wrapper', () => {
  // These two wrappers stack: mood first, then the voice marker (added
  // downstream in the sdk-client). Neither wraps the other; both precede the
  // words.
  const mooded = applyMood('hi', 'helpful');
  const withVoice = `[Audio mode]\n${mooded}`;
  assert.equal(
    withVoice,
    `[Audio mode]\n<mood>\n${MOODS.helpful.block}\n</mood>\n\nhi`,
  );
});

test('playful insults still commits to a correct answer', () => {
  // The persona copy has to keep the "helpful despite the teasing" contract —
  // that is the whole point of the mood, and it is the guardrail that keeps it
  // from being genuinely rude.
  const b = MOODS.playful.block!;
  assert.match(b, /ALWAYS still answer/);
  assert.match(b, /Never be mean/);
});

test('teacher persona explains rather than just answers', () => {
  const b = MOODS.teacher.block!;
  assert.match(b, /step by step/);
  assert.match(b, /reasoning/);
});
