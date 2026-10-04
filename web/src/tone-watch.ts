/**
 * ToneWatcher: spectral tripwire on the voice playback analyser.
 *
 * The user reports an occasional tone while the avatar talks. The server-side
 * TTS PCM/WAV has been verified clean (no narrowband peaks, no
 * repeated-sample patterns), so this watches the audio that actually reaches
 * the speakers — the AnalyserNode in the playback path — and reports a
 * sustained NARROW peak.
 *
 * Band is 100–200 Hz: the low-buzz window the user hears (perceptually
 * reported as a "120 Hz square wave"; 120 = 2× mains). The odd harmonics
 * (360/600/840/1080 Hz) fall above the 200 Hz ceiling and are NOT trigger
 * candidates — their levels are recorded in combDb/spectrum instead, which is
 * exactly the shape that confirms a square wave versus a lone tone.
 *
 * A "tone" = one bin in the band that (a) stands >= 10 dB above its IMMEDIATE
 * ±1-bin neighbours (1-bin prominence — a pure tone is 1-2 bins wide, a
 * broadband hump like the voice's own pitch has neighbours within a few dB of
 * the peak and cannot reach the gate — v3's ±30-bin contrast failed exactly
 * here, firing on the speaker's F0 on every word), (b) has real absolute
 * energy (>-45 dBFS), and (c) persists for >= 12 consecutive ~30ms frames
 * (~0.35s). A 3 s cooldown per 15 Hz frequency cluster means a genuinely
 * continuous tone reports at most once per 3 s instead of flooding the log.
 *
 * Every finding carries: prominenceDb (the 1-bin prominence that passed the
 * gate), combDb (levels at the 360/600/840/1080 odd harmonics), and a
 * full-spectrum snapshot (all bins, dBFS) — so the next occurrence is
 * unambiguously diagnosable (lone spike vs harmonic hump) without the user at
 * the computer.
 */
export interface ToneFinding {
  kind: 'tone';
  t0: number;           // first tick (performance.now)
  seenMs: number;       // lastTickAt - t0
  ticks: number;        // consecutive matching frames at report time
  meanHz: number;
  minHz: number;
  maxHz: number;
  peakDb: number;       // dBFS of the strongest peak bin seen
  prominenceDb: number; // dB the reported peak stands above its ±1-bin neighbours
  micRms: number | null; // input (mic) level at report time (feedback check)
  sampleRate: number;
  fftSize?: number;     // FFT size in use (bin width = sampleRate / fftSize)
  combDb?: number[];    // levels (dBFS) at the odd harmonics of 120 Hz: 360/600/840/1080
  spectrum?: number[];  // full magnitude spectrum, dBFS, 1 decimal; index i = i*sampleRate/fftSize Hz
}

type Hit = { hzSum: number; ticks: number; t0: number; meanHz: number; minHz: number; maxHz: number; peakDb: number; promDb: number; spec: number[] | null };

// a reported cluster is re-reportable only after this long
const REPORT_COOLDOWN_MS = 3000;
// hits whose mean frequency is within this (absolute Hz) share a cooldown slot
const CLUSTER_HZ = 15;

export class ToneWatcher {
  private running = false;
  private t = 0;
  private raf = 0;
  private buf = new Float32Array(0);
  private hits: Hit[] = [];
  private lastReport: Array<{ hz: number; at: number }> = [];
  constructor(
    private ctx: AudioContext,
    private analyser: AnalyserNode,
    private report: (f: ToneFinding) => void,
    private micLevel: () => number,
  ) {}
  start() {
    if (this.running) return;
    this.running = true; this.t = 0; this.hits = [];
    this.buf = new Float32Array(this.analyser.fftSize);
    const loop = () => {
      if (!this.running) return;
      if ((this.t++ & 1) === 0) this.tick(); // ~30ms @ 60fps
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
  private tick() {
    this.analyser.getFloatFrequencyData(this.buf);
    const n = this.buf.length;
    const fs = this.ctx.sampleRate;
    // 100–200 Hz low-buzz window: DC is excluded at the lo bound (≥ ~100 Hz);
    // the upper bound is the first bin at/above 200 Hz (exclusive), clamped to
    // the analyser's populated bins so a tail of 0 dB never reads as a tone.
    const lo = Math.max(1, Math.floor(100 / fs * n));
    const hi = Math.min(n - 1, Math.ceil(200 / fs * n));
    if (hi <= lo) return;
    // strongest bin in the band
    let pb = -1, pm = -Infinity;
    for (let i = lo; i < hi; i++) if (this.buf[i] > pm) { pm = this.buf[i]; pb = i; }
    if (pb < 0) return;
    const hz = fs * pb / n;
    // 1-bin prominence: a genuine tone is 1-2 bins wide, so its peak stands
    // far above BOTH immediate neighbours. A broad F0 hump (the voice's own
    // pitch) has neighbours within a few dB of the peak and cannot reach the
    // 10 dB gate — this is the gate that kills the v3 false-positive flood.
    // The window is clamped at the band edge so a peak at the window edge
    // (e.g. 197 Hz, 1 bin from the 200 ceiling) is judged against whatever
    // neighbours exist rather than a full ±1 pair.
    let hiNb = -Infinity, loNb = -Infinity;
    if (pb + 1 < n) hiNb = this.buf[pb + 1];
    if (pb - 1 >= 0) loNb = this.buf[pb - 1];
    const prom = pm - Math.max(hiNb, loNb);
    const cand = pm > -45 && prom >= 10;
    if (!cand) { this.hits = []; return; }
    // match an existing hit within 10% frequency, else start a new one
    const specLen = Math.min(this.buf.length, this.analyser.fftSize / 2 + 1);
    let hit = this.hits.find(h => Math.abs(h.meanHz - hz) / Math.max(100, hz) < 0.1);
    if (!hit) {
      if (this.hits.length >= 4) return;
      hit = {
        hzSum: 0, ticks: 0, t0: performance.now(), meanHz: hz, minHz: hz, maxHz: hz, peakDb: pm, promDb: prom,
        // the loudest frame is this one (a steady tone never exceeds its own
        // first level, so the snapshot must be taken at creation, not only on
        // a strict increase)
        spec: Array.from(this.buf.slice(0, specLen), v => Math.round(v * 10) / 10),
      };
      this.hits.push(hit);
    }
    hit.ticks++;
    hit.hzSum += hz;
    hit.meanHz = hit.hzSum / hit.ticks;
    hit.minHz = Math.min(hit.minHz, hz);
    hit.maxHz = Math.max(hit.maxHz, hz);
    if (pm > hit.peakDb) {
      hit.peakDb = pm;
      hit.promDb = prom;
      // a later, louder frame: keep its spectrum — it best shows the peak's
      // shape (lone spike vs harmonic hump) around the reported tone
      hit.spec = Array.from(this.buf.slice(0, specLen), v => Math.round(v * 10) / 10);
    }
    if (hit.ticks >= 12) {
      const now = performance.now();
      // 3 s cooldown per 15 Hz cluster: a continuous tone must not re-report
      // every 0.35 s (v3 flooded 347 findings in ~50 min of speech)
      const fresh = this.lastReport.filter(r => now - r.at < REPORT_COOLDOWN_MS);
      const dup = fresh.some(r => Math.abs(r.hz - hit.meanHz) <= CLUSTER_HZ);
      fresh.push({ hz: hit.meanHz, at: now });
      this.lastReport = fresh;
      if (dup) { this.hits = this.hits.filter(h => h !== hit); return; }
      const comb: number[] | undefined = hit.spec
        ? [360, 600, 840, 1080].map(hh => {
            const i = Math.min(specLen - 1, Math.max(0, Math.round(hh / (fs / n))));
            return hit.spec![i];
          })
        : undefined;
      const found: ToneFinding = {
        kind: 'tone',
        t0: hit.t0,
        seenMs: now - hit.t0,
        ticks: hit.ticks,
        meanHz: Math.round(hit.meanHz * 10) / 10,
        minHz: Math.round(hit.minHz * 10) / 10,
        maxHz: Math.round(hit.maxHz * 10) / 10,
        peakDb: Math.round(hit.peakDb * 10) / 10,
        prominenceDb: Math.round(hit.promDb * 10) / 10,
        micRms: Math.round(this.micLevel() * 1000) / 1000,
        sampleRate: fs,
        fftSize: n,
        combDb: comb,
        spectrum: hit.spec ?? undefined,
      };
      this.hits = this.hits.filter(h => h !== hit);
      console.debug('[pith-tone]', JSON.stringify(found));
      try { this.report(found); } catch (e) { console.warn('[pith-tone] report failed', e); }
    }
  }
}
