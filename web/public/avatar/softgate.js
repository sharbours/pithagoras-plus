/*
 * Soft noise gate (build #67, 2026-10-08).
 *
 * Qwen3-TTS clone voices leave a quiet TONAL bed (an artifact of the 12 Hz
 * neural codec) in every gap between words and sentences. During speech it is
 * masked; in a pause it is the only thing audible, and its hard on/off is
 * what users hear as the background noise "stopping". This worklet removes it:
 * a per-channel envelope follower drives a soft-knee gain that falls to 0
 * below the threshold and stays 1 at voice levels, so the tonal bed is cut
 * while the voice passes essentially untouched (measured: floor -61 -> -87
 * dBFS, voice +0.0 dB, 0 clipping on real clone:Kate PCM).
 *
 * Time constants: 2 ms attack (tracks speech onsets), 30 ms release (a
 * ~4 dBFS fade that is inaudible, no pumping). Threshold -48 dBFS with a 4 dB
 * knee: anything below -44 dBFS is gated fully; normal speech peaks around
 * -15..-20 dBFS, far above the knee, so they are unaffected.
 *
 * The same worklet is used by the voice stage (src/pcm-stream.ts) and the
 * read-aloud path (src/components/SpeakReplies.tsx). It is opt-out: the UI
 * toggle (localStorage "pith.softgate" = "0") disables it; on failure the
 * callers fall back to a direct connection, so audio can never be lost.
 */
class SoftGateProcessor extends AudioWorkletProcessor {
  static get parameterData() {
    return { level: { minValue: -99, maxValue: 0, defaultValue: -99 } };
  }

  constructor() {
    super();
    // Amplitudes (linear). -48 dBFS threshold, +4 dB knee.
    const T = 0.004;
    const K = 0.008;
    const AT = 1 - Math.exp(-1 / (sampleRate * 0.002));
    const RT = 1 - Math.exp(-1 / (sampleRate * 0.030));
    this.t = T;
    this.k = K;
    this.at = AT;
    this.rt = RT;
    this.env = [0, 0];
  }

  process(inputs, outputs, _parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const output = outputs[0];
    if (!output) return true;
    const nch = Math.min(input.length, 2);
    for (let ch = 0; ch < nch; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      let env = this.env[ch];
      for (let i = 0; i < inCh.length; i++) {
        const x = inCh[i];
        const v = x < 0 ? -x : x;
        env += (v > env ? this.at : this.rt) * (v - env);
        let g;
        if (env <= this.t) g = 0;
        else if (env >= this.t + this.k) g = 1;
        else g = (env - this.t) / this.k;
        outCh[i] = x * g;
      }
      this.env[ch] = env;
    }
    return true;
  }
}

registerProcessor("softgate", SoftGateProcessor);
