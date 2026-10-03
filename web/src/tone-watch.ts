/**
 * ToneWatcher: spectral tripwire on the voice playback analyser.
 *
 * The user reports an occasional even high-pitched tone/squeal while the
 * avatar talks; the pitch varies per episode. The server-side TTS PCM/WAV
 * has been verified clean (no narrowband peaks, no repeated-sample patterns),
 * so this watches the audio that actually reaches the speakers — the
 * AnalyserNode in the playback path — and reports sustained narrowband
 * high-frequency peaks.
 *
 * A "tone" = one spectral bin that (a) stands far above its neighbours
 * (peak-to-neighbor dB gap) and (b) has real absolute energy, persisting
 * for >= 12 consecutive ~30ms frames (~0.35s). Speech sibilants are
 * broadband and don't satisfy (a); a howl / feedback / oscillator does.
 *
 * Findings are posted to the portal (server log + session file) so the
 * frequency can be correlated with hardware (speaker resonance, USB audio
 * quirk, OS audio driver) without the user being at the computer.
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
  micRms: number | null; // input (mic) level at report time (feedback check)
  sampleRate: number;
}

export class ToneWatcher {
  private running = false;
  private t = 0;
  private raf = 0;
  private buf = new Float32Array(0);
  private hits: Array<{ hzSum: number; ticks: number; t0: number; meanHz: number; minHz: number; maxHz: number; peakDb: number }> = [];
  constructor(
    private ctx: AudioContext,
    private analyser: AnalyserNode,
    private report: (f: ToneFinding) => void,
    private micLevel: () => number,
  ) {}
  start() {
    if (this.running) return;
    this.running = true; this.t = 0;
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
    const lo = Math.max(2, Math.floor(1500 / fs * n));
    const hi = Math.min(n - 1, Math.ceil(16000 / fs * n));
    if (hi <= lo) return;
    // strongest bin in the band
    let pb = -1, pm = -Infinity;
    for (let i = lo; i <= hi; i++) if (this.buf[i] > pm) { pm = this.buf[i]; pb = i; }
    if (pb < 0) return;
    const hz = fs * pb / n;
    // neighbourhood average over ±30 bins (~±700 Hz): a pure tone is 1-2 bins
    // wide, so it stands far above its wide-band average; a sibilant or other
    // broadband speech energy (hundreds of Hz wide) does not.
    let sum = 0, cnt = 0;
    for (let k = 1; k <= 30; k++) {
      if (pb - k >= 0) { sum += this.buf[pb - k]; cnt++; }
      if (pb + k < n) { sum += this.buf[pb + k]; cnt++; }
    }
    const nbAvg = cnt ? sum / cnt : -Infinity;
    // narrowband + real energy: >12 dB above the wide-band neighbours and
    // above -45 dBFS
    const cand = pm > -45 && pm - nbAvg > 12;
    if (!cand) { this.hits = []; return; }
    // match an existing hit within 10% frequency, else start a new one
    let hit = this.hits.find(h => Math.abs(h.meanHz - hz) / Math.max(100, hz) < 0.1);
    if (!hit) {
      if (this.hits.length >= 4) return;
      hit = { hzSum: 0, ticks: 0, t0: performance.now(), meanHz: hz, minHz: hz, maxHz: hz, peakDb: pm };
      this.hits.push(hit);
    }
    hit.ticks++;
    hit.hzSum += hz;
    hit.meanHz = hit.hzSum / hit.ticks;
    hit.minHz = Math.min(hit.minHz, hz);
    hit.maxHz = Math.max(hit.maxHz, hz);
    hit.peakDb = Math.max(hit.peakDb, pm);
    if (hit.ticks >= 12) {
      const found: ToneFinding = {
        kind: 'tone',
        t0: hit.t0,
        seenMs: performance.now() - hit.t0,
        ticks: hit.ticks,
        meanHz: Math.round(hit.meanHz * 10) / 10,
        minHz: Math.round(hit.minHz * 10) / 10,
        maxHz: Math.round(hit.maxHz * 10) / 10,
        peakDb: Math.round(hit.peakDb * 10) / 10,
        micRms: Math.round(this.micLevel() * 1000) / 1000,
        sampleRate: fs,
      };
      this.hits = this.hits.filter(h => h !== hit);
      console.debug('[pith-tone]', JSON.stringify(found));
      try { this.report(found); } catch (e) { console.warn('[pith-tone] report failed', e); }
    }
  }
}
