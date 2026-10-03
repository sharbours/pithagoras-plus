import { test } from 'node:test';
import assert from 'node:assert/strict';
// The watcher runs on requestAnimationFrame; drive it deterministically in tests.
// Cbs are stored by id: a pending frame that gets cancelled before it runs is
// a no-op (mirrors the real API), so stopped watchers can't leak into later
// tests' frame budget.
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
const i4k = Math.round(4000 / BIN);
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
// Realistic speech-like spectrum: formant energy 200-3k Hz plus a sibilant
// ridge 3-9k Hz (broad, many bins at similar levels). This is what the
// watcher hears most of the time while the avatar talks.
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
test('reports a sustained narrowband 4 kHz tone over speech', async () => {
  resetRaf();
  const ctx = makeCtx(withTone(speechBase(), 4000, -6));
  const reports: unknown[] = [];
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  await driveFrames(w, 36); // 36 ticks
  w.stop();
  assert.equal(reports.length, 1);
  const f = reports[0] as any;
  assert.equal(f.kind, 'tone');
  // the peak bin is 4000 Hz quantized to the nearest bin (~±23 Hz)
  assert.ok(Math.abs(f.meanHz - 4000) < BIN, `meanHz ${f.meanHz}`);
  assert.ok(f.ticks >= 12);
  // seenMs depends on the host clock (a 1ms-resolution test clock makes it
  // small); in a real browser ~12 ticks ≈ 0.4s. Only sanity-bound it.
  assert.ok(f.seenMs >= 0 && f.seenMs <= 1000, `seenMs ${f.seenMs}`);
  assert.equal(f.sampleRate, FS);
  assert.equal(typeof f.peakDb, 'number');
  assert.equal(f.micRms, 0);
});
test('stays silent on speech without a lone spike (sibilant ridge)', async () => {
  resetRaf();
  const ctx = makeCtx(speechBase());
  const reports: unknown[] = [];
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  await driveFrames(w, 30);
  w.stop();
  assert.equal(reports.length, 0);
});
test('stays silent on silence and on a low-frequency hum below the 1 kHz floor', async () => {
  resetRaf();
  const silence = new Float32Array(FFT / 2 + 1).fill(-100);
  const hum: Float32Array = new Float32Array(FFT / 2 + 1).fill(-100);
  hum[Math.round(150 / BIN)] = -10; // 150 Hz — below the 1 kHz floor, must be ignored
  const reports: unknown[] = [];
  const w = new ToneWatcher(makeCtx(silence), (makeCtx(silence)).analyser, f => reports.push(f), () => 0);
  w.start();
  await driveFrames(w, 16);
  const w2 = new ToneWatcher(makeCtx(hum), (makeCtx(hum)).analyser, f => reports.push(f), () => 0);
  w2.start();
  await driveFrames(w2, 16);
  w.stop(); w2.stop();
  assert.equal(reports.length, 0);
});
test('reports a 18 kHz tone — above the old 16 kHz cap (integrated-speaker resonance region)', async () => {
  resetRaf();
  const d = speechBase();
  d[Math.round(18000 / BIN)] = -6;
  const ctx = makeCtx(d);
  const reports: unknown[] = [];
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  await driveFrames(w, 30); // 15 ticks ≥ 12
  w.stop();
  assert.equal(reports.length, 1);
  const f = reports[0] as any;
  assert.ok(f.meanHz >= 16000, `expected >16k, got ${f.meanHz}`);
  assert.ok(typeof f.fftSize === 'number' && f.fftSize === FFT);
  assert.ok(Array.isArray(f.spectrum) && f.spectrum.length === FFT / 2 + 1, 'spectrum snapshot present');
  assert.ok(f.spectrum[Math.round(18000 / BIN)] > -10, 'spectrum peaks at the tone bin');
});
test('a tone that fades before 12 ticks is not reported (persistence required)', async () => {
  resetRaf();
  const reports: unknown[] = [];
  let frame = 0;
  const base = speechBase();
  const ctx = {
    sampleRate: FS,
    analyser: { fftSize: FFT, getFloatFrequencyData: (b: Float32Array) => { b.set(base.subarray(0, Math.min(base.length, b.length))); if (frame < 8) b[i4k] = -6; } },
  } as unknown as AudioContext;
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  for (let f = 0; f < 24; f++) { frame++; const q = rafQ; rafQ = []; q.forEach(cb => cb()); }
  w.stop();
  assert.equal(reports.length, 0, 'a <0.3s blip must not fire');
});
