/** Buffer one spoken phrase so slower-than-realtime synthesis cannot interrupt words. */
export async function readPcmStream(
  body: ReadableStream<Uint8Array>, audio: AudioContext, signal: AbortSignal,
): Promise<AudioBuffer> {
  signal.throwIfAborted();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancelRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelRead, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(value); length += value.length;
    }
  } finally {
    signal.removeEventListener('abort', cancelRead);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
  if (!length || length % 2) throw new Error('Breeze returned incomplete PCM audio');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const buffer = audio.createBuffer(1, length / 2, 24000);
  const samples = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  signal.throwIfAborted();
  return buffer;
}

export async function playAudioBuffer(buffer: AudioBuffer, audio: AudioContext, destination: AudioNode, signal: AbortSignal, onStarted: (scheduledAt?:number) => void): Promise<void> {
  signal.throwIfAborted();
  const source = audio.createBufferSource(); source.buffer = buffer; source.connect(destination);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); source.disconnect(); resolve(); };
    const cancel = () => { source.onended = null; source.stop(); signal.removeEventListener('abort', cancel); source.disconnect(); reject(signal.reason); };
    source.onended = finish;
    signal.addEventListener('abort', cancel, { once: true });
    source.start(); onStarted(audio.currentTime);
    if (signal.aborted) cancel();
  });
}

/** Combined helper for consumers that only have one phrase. */
export async function playPcmStream(body: ReadableStream<Uint8Array>, audio: AudioContext, destination: AudioNode, signal: AbortSignal, onStarted: (scheduledAt?:number) => void): Promise<void> {
  const buffer = await readPcmStream(body, audio, signal);
  await playAudioBuffer(buffer, audio, destination, signal, onStarted);
}

/** Start from a small PCM cushion while the producer continues generating. */
export async function preparePcmSpeech(body: ReadableStream<Uint8Array>, audio: AudioContext, signal: AbortSignal) {
  const reader = body.getReader();
  const pending: AudioBuffer[] = [];
  const sources = new Set<AudioBufferSourceNode>();
  let destination: AudioNode | undefined, nextTime = 0, finished = false, carry: number | undefined;
  let buffered = 0, started = false, played = false;
  let ready!: () => void, rejectReady!: (error: unknown) => void;
  const initial = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  let finishPlay!: () => void, failPlay!: (error: unknown) => void;
  let onStarted: (scheduledAt?:number)=>void = () => {};
  const pump = () => {
    if (!destination || signal.aborted) return;
    for (const buffer of pending.splice(0)) {
      const source = audio.createBufferSource(); source.buffer = buffer; source.connect(destination);
      sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); if (finished && !sources.size) finishPlay(); };
      // The engine synthesizes slower than real time (RTF ~1.1-1.7), so while
      // it is generating the schedule can fall behind audio.currentTime (an
      // underrun). Scheduling into the past re-emits already-played audio on
      // top of the live playback — heard as repeating syllables that restart
      // from shorter and shorter points, ending in noise. Clamp forward to
      // now (+ a short gap) instead: a brief silence is imperceptible, overlap
      // is not.
      nextTime = nextTime < audio.currentTime ? audio.currentTime + 0.02 : Math.max(nextTime, audio.currentTime + 0.04);
      const scheduledAt=nextTime; source.start(nextTime); nextTime += buffer.duration;
      if (!started) { started = true; onStarted(scheduledAt); }
    }
    if (finished && !sources.size) finishPlay();
  };
  const cancel = () => {
    void reader.cancel().catch(() => {});
    for (const source of sources) { source.onended = null; source.stop(); source.disconnect(); }
    sources.clear(); rejectReady(signal.reason); failPlay?.(signal.reason);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const completed = (async () => {
    try {
      signal.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read(); signal.throwIfAborted();
        if (done) break;
        const bytes = new Uint8Array(value.length + (carry === undefined ? 0 : 1));
        if (carry !== undefined) bytes[0] = carry;
        bytes.set(value, carry === undefined ? 0 : 1);
        carry = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
        const count = Math.floor(bytes.length / 2);
        if (!count) continue;
        const buffer = audio.createBuffer(1, count, 24000), samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
        for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        pending.push(buffer); buffered += buffer.duration;
        // 1.5 s of buffer before first playback. The engine streams slower
        // than real time, so the cushion must cover the drift of the first
        // ~1.5 s of audio (~0.15-0.5 s at RTF 1.1-1.7) plus chunk-boundary
        // jitter. 0.65 s was tuned for a near-real-time producer and
        // guaranteed an underrun mid-first-phrase.
        if (buffered >= 1.5) ready();
        pump();
      }
      if (!buffered || carry !== undefined) throw new Error('Breeze returned incomplete PCM audio');
      finished = true; ready(); pump();
    } catch (error) { rejectReady(error); failPlay?.(error); throw error; }
    finally { reader.releaseLock(); }
  })();
  // The pipeline observes completion after this function has returned.
  void completed.catch(() => {});
  try { await initial; } catch (error) { signal.removeEventListener('abort', cancel); throw error; }
  return { completed, play: async (output: AudioNode, notify: (scheduledAt?:number) => void) => {
    signal.throwIfAborted();
    // Scheduling is one-shot per phrase. The pipeline may call play() again on
    // the same prepared speech (e.g. a hands-free barge-in re-arm); without this
    // guard the entire buffered queue would be re-scheduled from audio.currentTime,
    // overlapping the still-playing tail — heard as repeating syllables that
    // restart from shorter and shorter points, ending in noise.
    if (played) return;
    played = true;
    try {
      await new Promise<void>((resolve, reject) => { finishPlay = resolve; failPlay = reject; destination = output; onStarted = notify; pump(); });
    } finally { signal.removeEventListener('abort', cancel); }
  } };
}
