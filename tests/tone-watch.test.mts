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
const HALF = FFT / 2 + 1;
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
// just below the formant floor, so a low tone is contrasted against both the
// near-DC and the formants above it.
function speechBase(): Float32Array {
  const d = new Float32Array(HALF).fill(-100);
  for (let i = 0; i < HALF; i++) {
    const f = i * BIN;
    if (f >= 200 && f <= 3000) d[i] = -25;
    else if (f > 3000 && f <= 9000) d[i] = -30;
  }
  return d;
}
function binOf(hz: number) { return Math.round(hz / BIN); }
function withTone(base: Float32Array, hz: number, db: number): Float32Array {
  const d = base.slice();
  d[binOf(hz)] = db;
  return d;
}
// A BROAD low hump (the v3 false positive: the voice's own pitch/F0 ridge) —
// several adjacent bins at similar levels with a gentle peak. Its strongest
// bin has 1-bin prominence < 10 dB, so v4 must stay silent on it even though
// the peak is loud and persistent.
function withF0Hump(base: Float32Array, centerHz: number, peakDb: number): Float32Array {
  const d = base.slice();
  const c = binOf(centerHz);
  // 5-bin broad ridge: peak at centre, neighbours within a few dB
  d[c - 2] = peakDb - 6; d[c - 1] = peakDb - 2; d[c] = peakDb; d[c + 1] = peakDb - 2; d[c + 2] = peakDb - 6;
  return d;
}
test('reports a sustained narrow 120 Hz low hum (2x mains, square-wave fundamental)', async () => {
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
  // v4: the narrowness that passed the 1-bin gate
  assert.equal(typeof f.prominenceDb, 'number');
  assert.ok(f.prominenceDb >= 10, `narrow peak stood ${f.prominenceDb}dB over ±1 neighbours`);
  // v4: the odd-harmonic comb is recorded. A LONE 120 tone has no odd
  // harmonics, so the comb bins (360/600/840/1080) sit at the formant floor,
  // NOT elevated — this is the diagnostic that later separates a square wave.
  assert.ok(Array.isArray(f.combDb) && f.combDb.length === 4, 'combDb captured');
  for (const v of f.combDb) assert.ok(Number.isFinite(v) && v < -20, `comb ${f.combDb} not a strong harmonic for a lone tone`);
  assert.ok(Array.isArray(f.spectrum) && f.spectrum.length === HALF, 'full spectrum captured');
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
test('v3 regression: a BROAD F0 hump (voice pitch) stays silent even when loud and sustained', async () => {
  resetRaf();
  // 164 Hz broad ridge at -12 dB: loud and persistent, but its peak bin is
  // within a few dB of its ±1 neighbours (1-bin prominence < 10) — exactly the
  // shape that flooded 347 false findings in v3.
  const ctx = makeCtx(withF0Hump(speechBase(), 164, -12));
  const reports: unknown[] = [];
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  await driveFrames(w, 40); // 20 ticks, well past the 12-tick persistence floor
  w.stop();
  assert.equal(reports.length, 0, 'a broad F0 hump must NOT fire (the v3 flood)');
});
test('discriminates narrow vs broad at the SAME peak level: narrow fires, broad stays silent', async () => {
  resetRaf();
  const narrow = withTone(speechBase(), 141, -12);          // 1-bin spike: neighbours at -100
  const broad = withF0Hump(speechBase(), 141, -12);         // 3-5 bin hump: neighbours within 2-6 dB
  const rN: unknown[] = [], rB: unknown[] = [];
  const wn = new ToneWatcher(makeCtx(narrow), (makeCtx(narrow)).analyser, f => rN.push(f), () => 0);
  wn.start(); await driveFrames(wn, 36); wn.stop();
  const wb = new ToneWatcher(makeCtx(broad), (makeCtx(broad)).analyser, f => rB.push(f), () => 0);
  wb.start(); await driveFrames(wb, 36); wb.stop();
  assert.equal(rN.length, 1, 'a narrow 1-bin spike at -12dB must fire');
  assert.equal(rB.length, 0, 'a broad hump at the same -12dB peak must not fire');
});
test('stays silent on a 40 Hz hum below the floor and a 300 Hz tone above the ceiling', async () => {
  resetRaf();
  const silence = new Float32Array(HALF).fill(-100);
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
    analyser: { fftSize: FFT, getFloatFrequencyData: (b: Float32Array) => { b.set(base.subarray(0, Math.min(base.length, b.length))); if (frame < 8) b[binOf(120)] = -8; } },
  } as unknown as AudioContext;
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  w.start();
  for (let f = 0; f < 24; f++) { frame++; const q = rafQ; rafQ = []; q.forEach(cb => cb()); }
  w.stop();
  assert.equal(reports.length, 0, 'a <0.3s blip must not fire');
});
test('a continuous tone reports at most once per 3 s (cooldown prevents re-flooding the log)', async () => {
  resetRaf();
  const ctx = makeCtx(withTone(speechBase(), 120, -8));
  const reports: unknown[] = [];
  const w = new ToneWatcher(ctx, ctx.analyser, f => reports.push(f), () => 0);
  const t0 = performance.now();
  w.start();
  // enough ticks to build a SECOND 12-tick hit after the first reports
  // (first at tick 12, second candidate at tick 24). In real time the test
  // clock advances only milliseconds, so the second report falls inside the
  // 3 s cooldown and must be suppressed.
  await driveFrames(w, 64); // 32 ticks
  w.stop();
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 3000, `test ran in ${elapsed}ms (must stay inside the cooldown window for this assertion to be meaningful)`);
  assert.equal(reports.length, 1, `a continuous tone must not re-report every 0.35s (got ${reports.length}); this is what made v3 flood 347 rows in ~50 min`);
});
