import { useEffect, useRef, type MutableRefObject } from "react";
import type { VoicePhase } from "../hands-free";
import type { VoiceLevels } from "./VoiceStage";

/**
 * The 3D avatar (Avatar Lab, served from /avatar/) in the voice stage's avatar slot.
 * Same origin, driven with postMessage:
 *  - state: idle / listening / thinking / speaking, from the voice phase
 *  - mouth: the level of the speech actually playing (real lip sync), about 30 times a second
 *  - cues: each sentence's avatar tags, sent by the speech pipeline when its audio starts
 * Pick the character, framing and background by opening /avatar/ directly; this view reuses them.
 */
export function AvatarFrame({ phase, speaking, muted, levels }: {
  phase: VoicePhase; speaking: boolean; muted: boolean; levels: MutableRefObject<VoiceLevels>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const post = (message: object) => frame.current?.contentWindow?.postMessage({ avatar: message }, location.origin);
  const state = muted ? "idle"
    : speaking || phase === "Speaking" ? "speaking"
    : phase === "Thinking" || phase === "Compacting context" ? "thinking"
    : phase === "Hearing you" || phase === "Transcribing" ? "listening"
    : "idle";
  const latestState = useRef(state); latestState.current = state;
  useEffect(() => { post({ state }); }, [state]);

  useEffect(() => {
    if (!speaking) { post({ mouth: 0 }); return; }
    let raf = 0, last = 0;
    const tick = (time: number) => {
      if (time - last > 33) { last = time; post({ mouth: levels.current.output }); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speaking, levels]);

  useEffect(() => {
    const forward = (event: Event) => post((event as CustomEvent).detail);
    window.addEventListener("pith-avatar", forward);
    return () => window.removeEventListener("pith-avatar", forward);
  }, []);

  return <iframe ref={frame} className="voice-avatar-frame" src="/avatar/index.html?embed=1" title="Avatar"
    onLoad={() => post({ state: latestState.current })} />;
}
