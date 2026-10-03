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
 * Band is 1 kHz → Nyquist (full high end, incl. 16-20k where integrated
 * PC speakers tend to ring / alias — the old 1.5-16k cap was blind there).
 * Every finding carries a full-spectrum snapshot (all bins, dBFS) so the
 * shape — a lone 1-2 bin spike (digital tone / feedback) vs a broader
 * multi-harmonic hump (speaker resonance) — is captured, not just the
 * peak bin. Findings are posted to the portal (server log + session file)
 * so the frequency and shape can be correlated with hardware (speaker
 * resonance, USB audio quirk, OS audio driver) without the user at the
 * computer.
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
  fftSize?: number;     // FFT size in use (bin width = sampleRate / fftSize)
  spectrum?: number[];  // full magnitude spectrum, dBFS, 1 decimal; index i = i*sampleRate/fftSize Hz
}

export class ToneWatcher {
  private running = false;
  private t = 0;
  private raf = 0;
  private buf = new Float32Array(0);
  private hits: Array<{ hzSum: number; ticks: number; t0: number; meanHz: number; minHz: number; maxHz: number; peakDb: number; spec: number[] | null }> = [];
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
    // 1 kHz → Nyquist: the high end where integrated speakers ring/alias
    // (16-20k) included; low hums are out of scope for this symptom.
    const lo = Math.max(2, Math.floor(1000 / fs * n));
    // populated bins = fftSize/2 + 1 (DC..Nyquist); exclude the Nyquist bin
    // (a flat 0 at DC-folding, never a tone) → upper bound fftSize/2.
    const hi = Math.min(n - 1, this.analyser.fftSize / 2);
    if (hi <= lo) return;
    // strongest bin in the band. Upper limit = the analyser's populated bin
    // count (fftSize/2), excluding the Nyquist bin itself: a buffer larger
    // than the analyser's fftSize/2 (or a smaller analyser than the buffer)
    // leaves the tail at 0 dB, which would otherwise register as a fake
    // "tone". DC is excluded at the lo bound (≥ ~1 kHz here).
    let pb = -1, pm = -Infinity;
    for (let i = lo; i < hi; i++) if (this.buf[i] > pm) { pm = this.buf[i]; pb = i; }
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
    const specLen = Math.min(this.buf.length, this.analyser.fftSize / 2 + 1);
    let hit = this.hits.find(h => Math.abs(h.meanHz - hz) / Math.max(100, hz) < 0.1);
    if (!hit) {
      if (this.hits.length >= 4) return;
      hit = {
        hzSum: 0, ticks: 0, t0: performance.now(), meanHz: hz, minHz: hz, maxHz: hz, peakDb: pm,
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
      // a later, louder frame: keep its spectrum — it best shows the peak's
      // shape (lone spike vs harmonic hump) around the reported tone
      hit.spec = Array.from(this.buf.slice(0, specLen), v => Math.round(v * 10) / 10);
    }
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
        fftSize: n,
        spectrum: hit.spec ?? undefined,
      };
      this.hits = this.hits.filter(h => h !== hit);
      console.debug('[pith-tone]', JSON.stringify(found));
      try { this.report(found); } catch (e) { console.warn('[pith-tone] report failed', e); }
    }
  }
}
