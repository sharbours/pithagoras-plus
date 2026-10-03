import { test } from 'node:test';
import assert from 'node:assert/strict';
// The watcher runs on requestAnimationFrame; drive it deterministically in
// tests. Cbs are stored by id: a pending frame that gets cancelled before it
// runs is a no-op (mirrors the real API), so stopped watchers can't leak into
// later tests' frame budget.
let rafQ: Array<() => void> = [];
let rafId = 0;
const rafById = new Map<number, () => void>();
(globalThis as any).requestAnimationFrame = (cb: () => void) => {
  const id = ++rafId; rafById.set(id, cb);
  rafQ.push(() => { if (rafById.has(id)) cb(); });
  return id;
};
(globalThis as any).cancelAnimationFrame = (id: number) => { rafById.delete(id); };
function resetRaf() { rafQ = []; rafById.clear(); }
import { ToneWatcher } from '../web/src/tone-watch.js';

const FS = 48000, FFT = 2048, BIN = FS / FFT; // 23.4375 Hz/bin
function makeCtx(data: Float32Array) {
  return {
    sampleRate: FS,
    analyser: {
      fftSize: FFT,
      // real AnalyserNode fills fftSize/2+1 bins into the caller's buffer;
      // Float32Array.set throws if src is longer than dst, so copy min()
      getFloatFrequencyData: (b: Float32Array) => b.set(data.subarray(0, Math.min(data.length, b.length))),
    },
  } as unknown as AudioContext;
}
async function driveFrames(w: ToneWatcher, frames: number) {
  for (let f = 0; f < frames; f++) { const q = rafQ; rafQ = []; q.forEach(cb => cb()); }
}
// Speech-like spectrum: formant energy 200-3k Hz plus a sibilant ridge 3-9k Hz
// (broad, many bins at similar levels). The 100-200 Hz trigger window sits
// just below the formant floor, so a low hum is contrasted against both the
// near-DC and the formants above it.
function speechBase(): Float32Array {
  const d = new Float32Array(FFT / 2 + 1).fill(-100);
  for (let i = 0; i <= FFT / 2; i++) {
    const f = i * BIN;
    if (f >= 200 && f <= 3000) d[i] = -25;
    else if (f > 3000 && f <= 9000) d[i] = -30;
  }
  return d;
}
function withTone(base: Float32Array, hz: number, db: number): Float32Array {
  const d = base.slice();
  d[Math.round(hz / BIN)] = db;
  return d;
}
test('reports a sustained 120 Hz low hum (2x mains, square-wave fundamental)', async () => {
  resetRaf();
  const ctx = makeCtx(withTone(speechBase(), 120, -8));
  const reports: unknown[] = [];
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  await driveFrames(w, 36); // 18 ticks
  w.stop();
  assert.equal(reports.length, 1);
  const f = reports[0] as any;
  assert.equal(f.kind, 'tone');
  // the 120 Hz fundamental quantizes to the nearest bin (~±23 Hz) and sits in
  // the 100-200 Hz window
  assert.ok(Math.abs(f.meanHz - 120) < BIN, `meanHz ${f.meanHz}`);
  assert.ok(f.meanHz >= 100 && f.meanHz <= 200, `in-band ${f.meanHz}`);
  assert.ok(f.ticks >= 12);
  // seenMs depends on the host clock (a 1ms-resolution test clock makes it
  // small); in a real browser ~12 ticks ≈ 0.4s. Only sanity-bound it.
  assert.ok(f.seenMs >= 0 && f.seenMs <= 1000, `seenMs ${f.seenMs}`);
  assert.equal(f.sampleRate, FS);
  assert.equal(typeof f.peakDb, 'number');
  assert.equal(f.micRms, 0);
  assert.ok(Array.isArray(f.spectrum) && f.spectrum.length === FFT / 2 + 1, 'full spectrum captured');
});
test('stays silent on speech without a narrow low spike (formant ridge is broadband)', async () => {
  resetRaf();
  const ctx = makeCtx(speechBase());
  const reports: unknown[] = [];
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  await driveFrames(w, 30);
  w.stop();
  assert.equal(reports.length, 0);
});
test('stays silent on a 40 Hz hum below the floor and a 300 Hz tone above the ceiling', async () => {
  resetRaf();
  const silence = new Float32Array(FFT / 2 + 1).fill(-100);
  const low = withTone(speechBase(), 40, -8);   // below the 100 Hz floor
  const high = withTone(speechBase(), 300, -8); // above the 200 Hz ceiling
  const reports: unknown[] = [];
  const w1 = new ToneWatcher(makeCtx(silence), (makeCtx(silence)).analyser, f => reports.push(f), () => 0);
  w1.start(); await driveFrames(w1, 16); w1.stop();
  const w2 = new ToneWatcher(makeCtx(low), (makeCtx(low)).analyser, f => reports.push(f), () => 0);
  w2.start(); await driveFrames(w2, 16); w2.stop();
  const w3 = new ToneWatcher(makeCtx(high), (makeCtx(high)).analyser, f => reports.push(f), () => 0);
  w3.start(); await driveFrames(w3, 16); w3.stop();
  assert.equal(reports.length, 0, 'out-of-band tones (40 Hz, 300 Hz) must be ignored');
});
test('a 120 Hz hum that fades before 12 ticks is not reported (persistence required)', async () => {
  resetRaf();
  const reports: unknown[] = [];
  let frame = 0;
  const base = speechBase();
  const ctx = {
    sampleRate: FS,
    analyser: { fftSize: FFT, getFloatFrequencyData: (b: Float32Array) => { b.set(base.subarray(0, Math.min(base.length, b.length))); if (frame < 8) b[Math.round(120 / BIN)] = -8; } },
  } as unknown as AudioContext;
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  for (let f = 0; f < 24; f++) { frame++; const q = rafQ; rafQ = []; q.forEach(cb => cb()); }
  w.stop();
  assert.equal(reports.length, 0, 'a <0.3s blip must not fire');
});
