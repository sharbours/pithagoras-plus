import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERSONAS,
  PERSONA_MAX_CHARS,
  normalizePersona,
  applyPersona,
} from '../server/src/pi/persona.js';

// ---------------------------------------------------------------------------
// The seed catalogue
// ---------------------------------------------------------------------------

test('ships the four seed personalities the avatar panel starts from', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_PERSONAS),
    ['default', 'helpful', 'playful', 'teacher'],
    'keys must match the old mood keys so existing assignments keep meaning',
  );
  assert.equal(DEFAULT_PERSONAS.default.label, 'Default');
  assert.equal(DEFAULT_PERSONAS.default.text, '', 'default is the no-persona state');
  assert.equal(DEFAULT_PERSONAS.helpful.label, 'Helpful');
  assert.equal(DEFAULT_PERSONAS.playful.label, 'Playful insults');
  assert.equal(DEFAULT_PERSONAS.teacher.label, 'Teacher');
  for (const key of ['helpful', 'playful', 'teacher']) {
    assert.ok(DEFAULT_PERSONAS[key].text.length > 20, `${key} seed text should be substantive`);
  }
});

// ---------------------------------------------------------------------------
// normalizePersona — the client is the source of truth; the server only
// sanitizes what arrives.
// ---------------------------------------------------------------------------

test('normalizePersona is empty for no persona (byte-identical to pre-feature)', () => {
  for (const none of [null, undefined, '', '   ', 'default', 'DEFAULT', 7, { t: 1 }]) {
    assert.equal(normalizePersona(none), '', `expected "" for ${JSON.stringify(none)}`);
  }
});

test('normalizePersona trims but keeps real text', () => {
  assert.equal(normalizePersona('  Be warm.  '), 'Be warm.');
});

test('normalizePersona caps runaway text at PERSONA_MAX_CHARS', () => {
  const big = 'a'.repeat(PERSONA_MAX_CHARS + 500);
  assert.equal(normalizePersona(big).length, PERSONA_MAX_CHARS);
});

// ---------------------------------------------------------------------------
// applyPersona — the per-message injection
// ---------------------------------------------------------------------------

test('applyPersona is a no-op for an empty/absent persona', () => {
  const msg = 'hello, what is 2+2?';
  for (const none of [null, undefined, '', 'default', '  ']) {
    assert.equal(applyPersona(msg, none), msg);
  }
});

test('applyPersona prepends a <persona> block carrying the user text', () => {
  const out = applyPersona('hi there', 'You are grumpy but kind.');
  assert.equal(out, '<persona>\nYou are grumpy but kind.\n</persona>\n\nhi there');
});

test('the persona block comes BEFORE the user words, and stacks under [Audio mode]', () => {
  // Order the model sees it in: persona first, then the voice marker (added
  // downstream in the sdk-client), then the user's words.
  const out = applyPersona('hi', 'You are a pirate.');
  const withVoice = `[Audio mode]\n${out}`;
  assert.equal(withVoice, `[Audio mode]\n<persona>\nYou are a pirate.\n</persona>\n\nhi`);
});

test('a persona that is itself longer than the cap is truncated inside the block', () => {
  const big = 'x'.repeat(PERSONA_MAX_CHARS + 100);
  const out = applyPersona('hi', big);
  assert.equal(out, `<persona>\n${'x'.repeat(PERSONA_MAX_CHARS)}\n</persona>\n\nhi`);
});
