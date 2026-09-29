import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displaySpeechText, speechChunks } from '../web/src/voice.js';
import { buildTranscript } from '../web/src/transcript.js';
test('speech cues stay in TTS input but disappear from display including partial streamed tags', () => {
 const text = '(laugh) Hello. (cough) Excuse me. (clears throat) Ready. (sigh) Yes.';
 assert.equal(displaySpeechText(text, true), 'Hello. Excuse me. Ready. Yes.');
 assert.ok(speechChunks(text)[0].includes('(laugh)'));
 assert.equal(displaySpeechText('Hello. (cle', false), 'Hello.');
 assert.equal(displaySpeechText('Hello (for now)', true), 'Hello (for now)');
});
test('only responses to audio-marked requests get display filtering', () => {
  const events = [
   {seq:1,type:'portal_prompt',payload:{message:'Hello',voice:true}},
   {seq:2,type:'message_update',payload:{assistantMessageEvent:{type:'text_delta',delta:'(laugh) Hi.'}}},
   {seq:3,type:'portal_prompt',payload:{message:'Explain the tag'}},
   {seq:4,type:'message_update',payload:{assistantMessageEvent:{type:'text_delta',delta:'Use (laugh).'}}},
  ] as any;
  const items = buildTranscript(events);
  assert.equal(items[1].audio, true); assert.equal(items[3].audio, false);
  assert.equal(items[1].text, '(laugh) Hi.');
});

test('speechChunks: markdown cleanup strips stray underscores and formatting, but never inside avatar tags', () => {
  assert.equal(speechChunks('a_b and **bold** and [1] plain')[0], 'ab and bold and [1] plain');
  // The regression that killed the whole exercise library: every clip name is
  // underscore-delimited, and the old cleanup turned [exercise:deep_squat:2]
  // into [exercise:deepsquat:2] — an unknown clip the avatar silently drops —
  // while underscore-free poses/gestures kept working.
  const chunk = speechChunks('[exercise:deep_squat:2] First up, deep squats. [exercise:side_lunge:2] Next, side lunges.')[0];
  assert.ok(chunk.includes('[exercise:deep_squat:2]'), `deep_squat mangled: ${chunk}`);
  assert.ok(chunk.includes('[exercise:side_lunge:2]'), `side_lunge mangled: ${chunk}`);
  assert.equal(speechChunks('Just a normal sentence.')[0], 'Just a normal sentence.');
  // a long reply that must be split into several chunks keeps the tag intact
  const many = speechChunks('x '.repeat(400) + '[exercise:shoulder_rotation:3] Shoulder rotation. ' + 'y '.repeat(400));
  assert.equal(many.filter(c => c.includes('[exercise:shoulder_rotation:3]')).length, 1);
  // the spoken half stays free of avatar tags (TTS never hears them)
  assert.ok(!/\[(?:exercise|pose|expr):/.test(chunk.replace(/\[[^\]]*\]/g, '')));
});
