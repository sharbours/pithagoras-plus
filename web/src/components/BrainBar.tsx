import { useEffect, useState } from "react";
import { LuBrain, LuCpu } from "react-icons/lu";
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
 * Front-page brain switch.
 *
 * Sits at the very top of the session workspace and is visible in BOTH text
 * and voice mode (the composer and header hide in voice mode, so anything
 * that only lives there would be unusable for a voice-first deployment).
 *
 * It is a two-state control: tap the brain you want and it re-routes this
 * session through the portal's existing setConfig path (provider + modelId).
 * The active brain is highlighted; a green dot marks the local one, an accent
 * dot the remote Hermes one.
 */
export function BrainBar({ sessionId, session }: { sessionId: string; session: Session }) {
  // Seed from the session row for an immediate correct paint, then confirm via
  // the cheap /config route (never starts pi).
  const [active, setActive] = useState<BrainKey>(
    session.provider === "hermes" ? "hermes" : "local",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .config(sessionId)
      .then((cfg) => {
        if (cancelled) return;
        const prov: string = cfg?.state?.model?.provider ?? "";
        setActive(prov === "hermes" ? "hermes" : "local");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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

  return (
    <div className="shrink-0 border-b border-line bg-canvas/60 px-4 py-1.5">
      {/* No max-width centering: on small displays the switch hugs the left
          edge so it is where a thumb starts, and the row makes room for the
          compact toggle on the far right. */}
      <div className="flex w-full items-center gap-2">
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
        <span
          className="hidden truncate text-[11px] text-fg-faint sm:inline"
          title={BRAINS[active].label}
        >
          {BRAINS[active].label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <CompactToggle />
        </div>
      </div>
    </div>
  );
}
