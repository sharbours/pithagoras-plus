import { useCallback, useEffect, useRef, useState } from "react";
import { LuVolume2, LuVolumeX, LuLoaderCircle } from "react-icons/lu";
import { api } from "../api";
import type { Item } from "../transcript";
import { speechChunks } from "../voice";

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
 */

const KEY = "speakReplies.v1";

function readPcm(response: Response, sampleRate: number): Promise<AudioBuffer> {
  const body = response.body;
  if (!body) return Promise.reject(new Error("Speech generation failed"));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  return new Promise<AudioBuffer>((resolve, reject) => {
    const fail = (error: Error) => {
      void reader.cancel().catch(() => {});
      reject(error);
    };
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            length += value.length;
          }
        }
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        if (!length || length % 2) throw new Error("Incomplete speech stream");
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const buffer = new AudioBuffer({
          numberOfChannels: 1,
          length: length / 2,
          sampleRate,
        });
        const samples = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = view.getInt16(i * 2, true) / 32768;
        }
        resolve(buffer);
      } catch (e) {
        fail(e as Error);
      }
    })();
  });
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

  const synthesize = useCallback(
    async (text: string, signal: AbortSignal): Promise<AudioBuffer> => {
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
        // The previous request may still be releasing Breeze's GPU lock.
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
      const rate = Number(response.headers.get("x-sample-rate") ?? 24000);
      return readPcm(response, Number.isFinite(rate) && rate > 0 ? rate : 24000);
    },
    [sessionId],
  );

  const speakFresh = useCallback(
    async (chunks: string[]) => {
      if (busy.current || !context.current || context.current.state === "closed") return;
      if (!abort.current) abort.current = new AbortController();
      const signal = abort.current.signal;
      busy.current = true;
      setSpeaking(true);
      try {
        for (const chunk of chunks) {
          signal.throwIfAborted();
          if (!enabled) return;
          const buffer = await synthesize(chunk, signal);
          const audio = context.current;
          if (audio && (audio.state as string) !== "closed") {
            await playBuffer(buffer, audio, audio.destination, signal);
          }
        }
      } catch (e) {
        if (!aborted(e) && mounted.current) {
          setError((e as Error)?.message || "Speech generation failed");
        }
      } finally {
        busy.current = false;
        setSpeaking(false);
      }
    },
    [enabled, synthesize],
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
    // items is read once, when the user clicks — never on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arming, sessionId, releaseLease, stop, speakFresh]);

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
