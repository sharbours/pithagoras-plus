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
export function AvatarFrame({ phase, speaking, muted, levels, full, size }: {
  phase: VoicePhase; speaking: boolean; muted: boolean; levels: MutableRefObject<VoiceLevels>; full?: boolean; size?: { x: number; y: number };
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const post = (message: object) => frame.current?.contentWindow?.postMessage({ avatar: message }, location.origin);
  const state = muted ? "idle"
    : speaking || phase === "Speaking" ? "speaking"
    : phase === "Thinking" || phase === "Compacting context" ? "thinking"
    : phase === "Hearing you" || phase === "Transcribing" ? "listening"
    : "idle";
  const latestState = useRef(state); latestState.current = state;
  const latestFull = useRef(!!full); latestFull.current = !!full;
  const latestSize = useRef(size ?? { x: 100, y: 100 }); latestSize.current = size ?? { x: 100, y: 100 };
  useEffect(() => { post({ state }); }, [state]);
  // Enlarged (near-fullscreen) mode: the voice stage grows the avatar's slot and the
  // avatar page shows its ✕ button in response. Re-sent on every change so a frame
  // that reloads mid-session lands in the right view.
  useEffect(() => { post({ full: !!full }); }, [full]);
  // X/Y panel size: the voice stage tells the avatar page how big its panel is so
  // the page's own sliders (next to ⛶) mirror the current size.
  useEffect(() => { post({ panelSize: { x: latestSize.current.x, y: latestSize.current.y } }); }, [size?.x, size?.y]);

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
    onLoad={() => { post({ state: latestState.current }); post({ full: latestFull.current }); post({ panelSize: { x: latestSize.current.x, y: latestSize.current.y } }); }} />;
}
