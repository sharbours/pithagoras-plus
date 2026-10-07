import { useCallback, useEffect, useRef, useState } from "react";
import { LuVolume2, LuVolumeX, LuLoaderCircle } from "react-icons/lu";
import { api } from "../api";
import type { Item } from "../transcript";
import { speechChunks } from "../voice";
import { ToneWatcher } from "../tone-watch";

/**
 * Speaks new assistant replies out loud without a microphone.
 *
 * This is the TTS half of Voice mode with the STT half removed. It only plays
 * audio through an AudioContext; it never calls getUserMedia, so it works on a
 * plain HTTP portal where the browser blocks mic capture but not playback.
 *
 * Click to start: the last completed reply is spoken, then every new completed
 * reply is spoken as it arrives. Click again to stop. While enabled it holds a
 * voice lease so the lazy-loaded TTS model stays warm between replies.
 *
 * Build #64 (streaming back end): each 200-char chunk is decoded and played
 * in 128 ms windows from the live PCM stream, so the first audio starts ~0.6 s
 * after the request when the engine streams (instead of waiting for the whole
 * chunk) and the next chunk's synthesis is kicked off while the current one
 * plays. With a non-streaming engine the window simply fills slower (the
 * whole-chunk behavior of #63 is the fallback), so this is a strict upgrade.
 */

const KEY = "speakReplies.v1";

// 128 ms of 24 kHz mono audio. One window is the playback quantum; the hop
// between windows is a few ms of buffer scheduling (inaudible).
const WINDOW_FRAMES = 3072;
const STREAM_RATE = 24000; // the adapter guarantees 24 kHz s16le mono

/**
 * Decode the PCM response body into sequential 128 ms AudioBuffers.
 * Every byte is consumed: a single read spanning several windows yields
 * several windows, and the final partial window (the chunk's tail) is the
 * last yield. Respects the abort signal; the body reader is released on any
 * exit path (including g.return()).
 */
async function* audioWindows(
  response: Response,
  context: AudioContext,
  signal: AbortSignal,
): AsyncGenerator<AudioBuffer> {
  const body = response.body;
  if (!body) throw new Error("Speech generation failed");
  const reader = body.getReader();
  const samples = new Float32Array(WINDOW_FRAMES);
  let count = 0;
  const make = (n: number): AudioBuffer => {
    const buffer = context.createBuffer(1, n, STREAM_RATE);
    buffer.getChannelData(0).set(samples.subarray(0, n));
    return buffer;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
      const frames = value.length >> 1;
      let src = 0;
      while (src < frames) {
        const take = Math.min(frames - src, WINDOW_FRAMES - count);
        for (let i = 0; i < take; i++) {
          samples[count + i] = view.getInt16((src + i) * 2, true) / 32768;
        }
        src += take;
        count += take;
        if (count === WINDOW_FRAMES) {
          yield make(WINDOW_FRAMES);
          count = 0;
        }
      }
    }
    if (count > 0) yield make(count); // tail: the chunk's last partial window
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function playBuffer(
  buffer: AudioBuffer,
  context: AudioContext,
  destination: AudioNode,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const finish = () => {
      source.onended = null;
      source.disconnect();
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      reject(signal.reason ?? new Error("Stopped"));
    };
    source.onended = finish;
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    source.start();
  });
}

const aborted = (e: unknown): boolean =>
  e instanceof Error && (e.name === "AbortError" || e.name === "DOMException" || e.name === "TimeoutError");

function readFlag(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function SpeakReplies({
  sessionId,
  items,
  voiceActive = false,
}: {
  sessionId: string;
  items: Item[];
  voiceActive?: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(readFlag);
  const [arming, setArming] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");

  const mounted = useRef(false);
  const context = useRef<AudioContext | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const lease = useRef<string | null>(null);
  const afterSeq = useRef(-1);

  const setEnabledFlag = (value: boolean) => {
    try {
      localStorage.setItem(KEY, value ? "1" : "0");
    } catch {
      // private mode or full storage — a convenience, not a failure
    }
    setEnabled(value);
  };

  const releaseLease = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        await fetch(`/api/sessions/${sessionId}/voice/connection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: id, active: false }),
          keepalive: true,
        });
      } catch {
        // the server sweeps stale leases on its own
      }
    },
    [sessionId],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    const id = lease.current;
    lease.current = null;
    void releaseLease(id ?? "");
    const audio = context.current;
    context.current = null;
    if (audio && audio.state !== "closed") void audio.close();
    busy.current = false;
    setSpeaking(false);
  }, [releaseLease]);

  /** Fetch one chunk's PCM stream (retries the engine's 409 busy window). */
  const fetchStream = useCallback(
    async (text: string, signal: AbortSignal): Promise<Response> => {
      let response: Response;
      const deadline = Date.now() + 20000;
      for (;;) {
        signal.throwIfAborted();
        response = await fetch(`/api/sessions/${sessionId}/voice/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/pcm" },
          body: JSON.stringify({ text, source: "speak-replies" }),
          signal,
        });
        if (response.ok) break;
        const failure = (await response.json().catch(() => ({}))) as { error?: string };
        const busy409 =
          response.status === 409 ||
          (response.status === 502 && /^Breeze returned HTTP 409/.test(failure.error || ""));
        if (!busy409 || Date.now() >= deadline) {
          throw new Error(failure.error || "Speech generation failed");
        }
        // The previous request may still be releasing the engine's GPU lock.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, 600);
          const cancel = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("Stopped"));
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
      }
      return response;
    },
    [sessionId],
  );

  /** Open a chunk's PCM stream and pull its first 128 ms window (the TTFB
   *  point for that chunk). Throws on an empty stream so the caller skips it
   *  instead of hanging. */
  const openWindows = useCallback(
    async (text: string, signal: AbortSignal) => {
      const audio = context.current;
      if (!audio) throw new Error("No audio context");
      const response = await fetchStream(text, signal);
      const gen = audioWindows(response, audio, signal);
      const first = await gen.next();
      if (first.done) {
        throw new Error("Speech generation returned no audio");
      }
      return { gen, first };
    },
    [fetchStream],
  );

  const speakFresh = useCallback(
    async (chunks: string[]) => {
      if (busy.current || !context.current || context.current.state === "closed") return;
      if (!abort.current) abort.current = new AbortController();
      const signal = abort.current.signal;
      busy.current = true;
      setSpeaking(true);
      // Spectral tripwire on the playback path: catches a sustained
      // narrowband high-frequency tone (the "squeal while talking" symptom)
      // and reports it to the server, where the tone was verified clean.
      let analyser: AnalyserNode | null = null;
      let toneWatcher: ToneWatcher | null = null;
      // 1-ahead: while chunk i plays, chunk i+1 is already being fetched and
      // its first window pulled. With the streaming engine that first window
      // arrives in <1 s, so the hop between chunks is a few ms; with a
      // non-streaming engine the fetch simply takes the full generation time
      // (the #63 behavior) — at most one request in flight, so the engine's
      // 409-while-busy contract holds.
      type Part = { gen: AsyncGenerator<AudioBuffer>; first: IteratorResult<AudioBuffer> };
      let next: Promise<Part> | null = null;
      const close = (part: Part) => {
        void part.gen.return?.(undefined).catch(() => {});
      };
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (signal.aborted || !enabled) break;
          const audio = context.current;
          if (!audio || (audio.state as string) === "closed") break;
          if (!analyser) {
            analyser = audio.createAnalyser();
            analyser.fftSize = 2048;
            analyser.connect(audio.destination);
            toneWatcher = new ToneWatcher(audio, analyser, (finding) => {
              fetch(`/api/sessions/${sessionId}/voice/tones`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ finding }) }).catch(() => {});
            }, () => 0);
          }
          // Start chunk i's stream now (or take the prefetched one).
          const pending = next ?? (next = openWindows(chunks[i], signal));
          next = null;
          const part = await pending;
          if (signal.aborted || !enabled) {
            close(part);
            break;
          }
          let r = part.first;
          while (!r.done) {
            await playBuffer(r.value, audio, analyser, signal);
            if (signal.aborted || !enabled) break;
            r = await part.gen.next();
          }
          close(part);
          if (signal.aborted || !enabled) break;
          // Kick off the next chunk now that this one has finished.
          if (i + 1 < chunks.length) {
            next = openWindows(chunks[i + 1], signal);
          }
        }
        // Drain a prefetched-but-unplayed chunk (abort or the last one
        // settled) without letting its rejection escape.
        if (next) await next.catch(() => {});
        // Let the last chunk finish playing before releasing the speaking state.
      } catch (e) {
        if (!aborted(e) && mounted.current) {
          setError((e as Error)?.message || "Speech generation failed");
        }
      } finally {
        next = null;
        toneWatcher?.stop();
        analyser?.disconnect();
        busy.current = false;
        setSpeaking(false);
      }
    },
    [enabled, openWindows],
  );

  const start = useCallback(
    async (skipLast = false, itemsSnapshot?: Item[]) => {
      if (arming || context.current) return;
      setArming(true);
      setError("");
      try {
        const AudioContextCtor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) throw new Error("This browser does not support audio playback");
        const audio = new AudioContextCtor();
        if (audio.state === "suspended") await audio.resume().catch(() => {});
        context.current = audio;
        const client = `speak-replies:${sessionId}`;
        const res = await fetch(`/api/sessions/${sessionId}/voice/connection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client, active: true }),
        });
        if (res.ok) lease.current = client;
        else await releaseLease(client);
        if (!mounted.current) {
          stop();
          return;
        }
        // Speak the last completed reply, then only replies that complete after
        // this; the effect below re-scans on every new item and picks the rest
        // up because their sequence number is newer than afterSeq. When
        // resuming after voice mode (skipLast), start at the last reply's seq:
        // VoiceControl just spoke it, and the items effect has already marked
        // anything older as seen, so nothing gets repeated.
        const itemList = itemsSnapshot ?? items;
        afterSeq.current = 0;
        const last = [...itemList].reverse().find(
          (i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant" && i.done,
        );
        if (last) afterSeq.current = Number(last.id.slice(1)) - (skipLast ? 0 : 1);
        setEnabledFlag(true);
        const chunks = last ? speechChunks(last.text) : [];
        if (chunks.length && !skipLast) await speakFresh(chunks);
      } catch (e) {
        if (mounted.current) setError((e as Error)?.message || "Could not start speech output");
        stop();
        if (mounted.current) setEnabledFlag(false);
      } finally {
        if (mounted.current) setArming(false);
      }
    },
    // items is read once, when the user clicks — never on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [arming, sessionId, releaseLease, stop, speakFresh],
  );

  // Reset per session: a different session has a different reply stream, and a
  // lease belongs to the session that took it. Never auto-start while voice
  // mode is active: VoiceControl already speaks the replies, and a second
  // independent TTS consumer produced a duplicated "echo" of every answer.
  useEffect(() => {
    stop();
    afterSeq.current = -1;
    setError("");
    if (enabled && !voiceActive) void start();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Voice mode owns the audio output: when it turns on, stop read-aloud and
  // reset the high-water mark so the items effect can never synthesize again
  // (a second TTS consumer on the same replies produced the duplicated
  // "echo"). When it turns off, resume from the latest reply — everything up
  // to and including it has been heard (spoken by voice mode), so only
  // genuinely new replies get read aloud.
  const wasVoiceActive = useRef(voiceActive);
  useEffect(() => {
    if (voiceActive) {
      afterSeq.current = -1;
      stop();
    } else if (wasVoiceActive.current && enabled) {
      void start(true, items);
    }
    wasVoiceActive.current = voiceActive;
  }, [voiceActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only offered where the Voice add-on is installed and enabled: the speech
  // endpoint refuses everything else, so a disabled add-on is nothing here.
  useEffect(() => {
    mounted.current = true;
    api
      .voice()
      .then((config) => {
        if (mounted.current) setAvailable(config.enabled === true);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  // Speak replies once their text is final, never while it is still streaming.
  // The high-water mark advances even while voice mode is active (marking those
  // replies seen) but never synthesizes: VoiceControl owns the audio output,
  // and a second consumer produced the duplicated "echo" of every answer.
  useEffect(() => {
    if (!enabled || afterSeq.current < 0) return;
    const maySpeak = !voiceActive;
    const fresh: string[] = [];
    let newest = afterSeq.current;
    for (const item of items) {
      if (item.kind !== "assistant" || !item.done) continue;
      const seq = Number(item.id.slice(1));
      if (seq > newest) {
        if (seq > afterSeq.current && maySpeak) fresh.push(...speechChunks(item.text));
        newest = seq;
      }
    }
    afterSeq.current = newest;
    if (fresh.length) void speakFresh(fresh);
  }, [items, enabled, speakFresh]);

  // Release the lease and close the context when the component goes away.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  if (!available) return null;

  const title = enabled
    ? speaking
      ? "Speaking replies — click to stop"
      : "Replies are read aloud — click to stop"
    : "Read new replies aloud (no microphone needed)";

  return (
    <>
      {error && !enabled && (
        <p
          role="alert"
          className="absolute bottom-full right-0 mb-3 w-64 rounded-xl border border-line bg-surface p-3 text-xs text-danger shadow-pop"
        >
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          if (enabled) {
            stop();
            setEnabledFlag(false);
          } else {
            void start();
          }
        }}
        disabled={arming}
        aria-pressed={enabled}
        aria-label={title}
        title={title}
        className="prompt-action"
      >
        {arming ? (
          <LuLoaderCircle aria-hidden className="animate-spin" />
        ) : enabled ? (
          <LuVolume2 aria-hidden className={speaking ? "animate-pulse" : ""} />
        ) : (
          <LuVolumeX aria-hidden />
        )}
      </button>
    </>
  );
}
