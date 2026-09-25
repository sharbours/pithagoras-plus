import { useEffect, useState } from "react";
import { LuMonitorSmartphone, LuMonitor } from "react-icons/lu";
import { cycleCompactMode, getCompactMode, isCompact, subscribeCompact, type CompactMode } from "../compact-mode";

/**
 * Low-profile toggle that cycles compact mode auto -> on -> off, and remembers
 * the choice. Lives in the top row next to the brain switch so it is reachable
 * without hunting. The active (non-auto) choice is marked so a forced mode is
 * never a silent surprise.
 */
export function CompactToggle() {
  const [mode, setMode] = useState<CompactMode>(getCompactMode());
  const [active, setActive] = useState(isCompact());
  useEffect(() => subscribeCompact(() => {
    setMode(getCompactMode());
    setActive(isCompact());
  }), []);

  const label = mode === "auto"
    ? (active ? "Compact: auto (on)" : "Compact: auto (off)")
    : mode === "on" ? "Compact: on" : "Compact: off";

  return (
    <button
      type="button"
      onClick={() => setMode(cycleCompactMode())}
      title={label + " — tap to cycle"}
      aria-label={label}
      aria-pressed={active}
      className={`compact-toggle ${active ? "is-active" : ""}`}
    >
      {active ? <LuMonitorSmartphone /> : <LuMonitor />}
    </button>
  );
}
