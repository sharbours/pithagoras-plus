import { useEffect, useRef, useState } from "react";
import { LuShieldAlert, LuShieldCheck } from "react-icons/lu";
import { api } from "../api";

type Choice = "once" | "always" | "deny";

interface Approval {
  runId: string;
  requestId: string | null;
  command: string;
  description: string;
  patternKey: string | null;
  choices: string[];
  since: number;
}

/**
 * Permanent permission-response strip for the Hermes Agent brain.
 *
 * When Hermes (192.168.0.197) needs to run a flagged command, the run parks
 * in waiting_for_approval and the hermes-bridge records it. This strip polls
 * the portal's /api/approvals proxy and shows the request with three
 * buttons — Yes (once) / Always / No — which resolve the run right here,
 * from the browser, the same way the Hermes TUI pop-up does on a desktop.
 *
 * It sits in the top strip, visible in BOTH text and voice mode (the
 * composer and header hide in voice mode, so a transient toast there would
 * be unusable for a voice-first deployment). While idle it stays a thin,
 * low-profile strip; when a request lands it expands to show the command.
 */
export function PermissionBar({ active }: { active: boolean }) {
  const [items, setItems] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<Choice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await api.approvals();
        if (!cancelled) setItems(res.approvals ?? []);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) timer.current = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active]);

  const resolve = async (runId: string, requestId: string | null, choice: Choice) => {
    if (busy) return;
    setBusy(choice);
    try {
      await api.resolveApproval(runId, choice);
      setItems((prev) => prev.filter((a) => a.runId !== runId));
    } catch {
      // leave the row up so the user can retry
    } finally {
      setBusy(null);
    }
  };

  const pending = items.length > 0;
  const first = items[0];

  return (
    <div className="shrink-0 border-b border-line bg-canvas/60 px-4 py-1.5">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
          Permission
        </span>
        {!pending ? (
          <span className="flex items-center gap-1.5 text-[11px] text-fg-faint">
            <LuShieldCheck className="h-3.5 w-3.5 text-ok/70" />
            none requested
          </span>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
              <LuShieldAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" title={first?.command}>
                {first?.command || "command requires approval"}
              </span>
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => first && resolve(first.runId, first.requestId, "once")}
                title="Allow this one time"
                className="rounded-md border border-ok/40 bg-ok/12 px-2.5 py-1 text-xs text-ok transition disabled:opacity-50"
              >
                Yes – once
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => first && resolve(first.runId, first.requestId, "always")}
                title="Allow forever for this kind of command"
                className="rounded-md border border-accent/40 bg-accent/12 px-2.5 py-1 text-xs text-accent transition disabled:opacity-50"
              >
                Yes – always
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => first && resolve(first.runId, first.requestId, "deny")}
                title="Deny"
                className="rounded-md border border-danger/40 bg-danger/12 px-2.5 py-1 text-xs text-danger transition disabled:opacity-50"
              >
                No
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
