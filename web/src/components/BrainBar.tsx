import { useEffect, useState } from "react";
import { LuBrain, LuCpu, LuHeart, LuMessageSquare, LuSmile, LuGraduationCap } from "react-icons/lu";
import { api, type Session } from "../api";
import { CompactToggle } from "./CompactToggle";

/**
 * The two brains this deployment can run on. Editing the model later means
 * editing these two lines — keep them in step with settings.json's
 * llamaSettings.servers and defaultModel.
 */
const BRAINS = {
  local: {
    provider: "llama-server=http://127.0.0.1:8080",
    modelId: "qwen3-8b",
    label: "Qwen3-8B (local)",
    short: "Local",
    Icon: LuCpu,
  },
  hermes: {
    provider: "hermes",
    modelId: "hermes-agent",
    label: "Hermes Agent (.197)",
    short: "Hermes",
    Icon: LuBrain,
  },
} as const;

type BrainKey = keyof typeof BRAINS;

/**
 * Conversation "moods" — a per-session persona the agent adopts. A mood is not
 * a model: it does not route anywhere, it changes how the agent talks. The
 * server folds the chosen persona into every message (not the system prompt),
 * so switching it takes effect on the very next turn without restarting the
 * model, and it is stored on the session row so it survives a restart.
 *
 * "default" is the no-mood state — no persona block is injected at all.
 * Adding a mood here (and on the server in server/src/pi/mood.ts) is all it
 * takes; the selector renders whatever keys exist.
 */
const MOODS = {
  default: { label: "Default", Icon: LuMessageSquare },
  helpful: { label: "Helpful", Icon: LuHeart },
  playful: { label: "Playful insults", Icon: LuSmile },
  teacher: { label: "Teacher", Icon: LuGraduationCap },
} as const;

type MoodKey = keyof typeof MOODS;
const MOOD_ORDER: MoodKey[] = ["default", "helpful", "playful", "teacher"];

/**
 * Front-page brain + mood switch.
 *
 * Sits at the very top of the session workspace and is visible in BOTH text
 * and voice mode (the composer and header hide in voice mode, so anything
 * that only lives there would be unusable for a voice-first deployment).
 *
 * The Brain side is a two-state control: tap the brain you want and it
 * re-routes this session through the portal's setConfig path (provider +
 * modelId). The Mood side is a persona selector that writes to the same
 * setConfig route but changes only the message-level persona, so it never
 * restarts the model and applies immediately. The active choice is
 * highlighted; a green dot marks the local brain, an accent dot the remote
 * Hermes one, and a coloured dot the active mood.
 */
export function BrainBar({ sessionId, session }: { sessionId: string; session: Session }) {
  // Seed from the session row for an immediate correct paint, then confirm via
  // the cheap /config route (never starts pi).
  const [active, setActive] = useState<BrainKey>(
    session.provider === "hermes" ? "hermes" : "local",
  );
  const [mood, setMood] = useState<MoodKey>(
    session.mood && (MOODS as any)[session.mood] ? (session.mood as MoodKey) : "default",
  );
  const [busy, setBusy] = useState(false);
  const [moodBusy, setMoodBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .config(sessionId)
      .then((cfg) => {
        if (cancelled) return;
        const prov: string = cfg?.state?.model?.provider ?? "";
        setActive(prov === "hermes" ? "hermes" : "local");
        const m = cfg?.state?.mood;
        if (m && (MOODS as any)[m]) setMood(m as MoodKey);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // If the session prop is refreshed (e.g. after a list update) adopt its mood
  // so the control stays in step without needing its own fetch.
  useEffect(() => {
    if (session.mood && (MOODS as any)[session.mood]) {
      setMood(session.mood as MoodKey);
    }
  }, [session.mood]);

  const switchTo = async (target: BrainKey) => {
    if (target === active || busy) return;
    setBusy(true);
    try {
      const b = BRAINS[target];
      const res = await api.setConfig(sessionId, { provider: b.provider, modelId: b.modelId });
      // Trust the server's word on which model it settled onto.
      const settled: string = res?.state?.model?.provider ?? "";
      setActive(settled === "hermes" ? "hermes" : "local");
    } catch {
      // Leave the highlight where it is; the user can retry.
    } finally {
      setBusy(false);
    }
  };

  const switchMood = async (target: MoodKey) => {
    if (target === mood || moodBusy) return;
    setMoodBusy(true);
    // Update the highlight immediately — the change is cheap and local.
    setMood(target);
    try {
      await api.setConfig(sessionId, { mood: target });
    } catch {
      // Revert on failure so the control never lies about state.
      setMood(session.mood && (MOODS as any)[session.mood] ? (session.mood as MoodKey) : "default");
    } finally {
      setMoodBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-line bg-canvas/60 px-4 py-1.5">
      {/* No max-width centering: on small displays the switch hugs the left
          edge so it is where a thumb starts, and the row makes room for the
          compact toggle on the far right. */}
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">Brain</span>
        <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
          {(["local", "hermes"] as BrainKey[]).map((k) => {
            const b = BRAINS[k];
            const on = active === k;
            return (
              <button
                key={k}
                type="button"
                disabled={busy}
                onClick={() => switchTo(k)}
                title={b.label}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition disabled:opacity-50 ${
                  on
                    ? k === "hermes"
                      ? "bg-accent/12 text-accent"
                      : "bg-ok/12 text-ok"
                    : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
                }`}
              >
                <b.Icon className="h-3.5 w-3.5" />
                {b.short}
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    on ? (k === "hermes" ? "bg-accent" : "bg-ok") : "bg-raised"
                  }`}
                  title={on ? "active" : "standby"}
                />
              </button>
            );
          })}
        </div>
        {busy && <span className="text-[11px] text-fg-faint">switching…</span>}

        {/* The mood selector sits right next to the brain switch — same row,
            same visual weight — because it is the other per-session dial. */}
        <span className="ml-2 text-[11px] font-medium uppercase tracking-wide text-fg-faint">Mood</span>
        <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
          {MOOD_ORDER.map((k) => {
            const m = MOODS[k];
            const on = mood === k;
            // Each mood gets its own active tint so a glance says which one is
            // on; default is neutral since it means "no persona".
            const onCls =
              k === "default"
                ? "bg-fg/10 text-fg-muted"
                : k === "helpful"
                  ? "bg-ok/12 text-ok"
                  : k === "playful"
                    ? "bg-warn/12 text-warn"
                    : "bg-accent/12 text-accent";
            return (
              <button
                key={k}
                type="button"
                disabled={moodBusy}
                onClick={() => switchMood(k)}
                title={m.label}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition disabled:opacity-50 ${
                  on ? onCls : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
                }`}
              >
                <m.Icon className="h-3.5 w-3.5" />
                <span className={k === "playful" ? "hidden sm:inline" : undefined}>{m.label}</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    on
                      ? k === "default"
                        ? "bg-fg-subtle"
                        : k === "helpful"
                          ? "bg-ok"
                          : k === "playful"
                            ? "bg-warn"
                            : "bg-accent"
                      : "bg-raised"
                  }`}
                  title={on ? "active" : "standby"}
                />
              </button>
            );
          })}
        </div>
        {moodBusy && <span className="text-[11px] text-fg-faint">setting…</span>}

        <div className="ml-auto flex items-center gap-1">
          <CompactToggle />
        </div>
      </div>
    </div>
  );
}
