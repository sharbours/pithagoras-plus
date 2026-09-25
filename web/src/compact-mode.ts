/**
 * Compact / small-display mode.
 *
 * A tiny external store (not React state) so it can be read from anywhere —
 * App installs the <html class="compact"> and resize watching, the BrainBar's
 * toggle button re-renders on change, and the CSS keys off that single class.
 *
 * Detection is deliberately NOT user-agent based: a reflashed Echo Show 5
 * reports an arbitrary Android UA. Instead we key off the geometry that
 * actually constrains the layout — a short, wide, touch display (the Show is
 * 960x480) or a small portrait phone. The answer can always be overridden by
 * hand (auto -> on -> off), and the choice is remembered.
 */

export type CompactMode = "auto" | "on" | "off";

const KEY = "pithagoras.compactMode";

function readMode(): CompactMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "on" || v === "off" || v === "auto") return v;
  } catch {}
  return "auto";
}

function writeMode(m: CompactMode) {
  try {
    localStorage.setItem(KEY, m);
  } catch {}
}

/** True for the layouts we optimise: short-landscape (Echo Show 5 = 960x480)
 *  or small portrait phones, in both cases on a touch device. */
function autoDetect(): boolean {
  if (typeof window === "undefined") return false;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const touch = "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
  if (!touch) return false;
  const shortLandscape = w > h && h <= 560 && w <= 1280;
  const smallPortrait = h > w && w <= 480 && h <= 900;
  return shortLandscape || smallPortrait;
}

let mode: CompactMode = readMode();
let compact = false;
const subs = new Set<() => void>();

function recompute() {
  compact = mode === "on" ? true : mode === "off" ? false : autoDetect();
  const root = typeof document !== "undefined" ? document.documentElement : null;
  if (root) root.classList.toggle("compact", compact);
}

function emit() {
  for (const fn of [...subs]) fn();
}

/**
 * Install compact mode: apply the class, watch resizes (a display can rotate
 * or the browser chrome can change the viewport), and stop on unmount.
 * Idempotent-safe enough for the single App shell that calls it.
 */
let installed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
export function initCompact(): () => void {
  recompute();
  if (installed) return () => {};
  installed = true;
  const onResize = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (mode === "auto") recompute();
      emit();
    }, 150);
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
    if (timer) clearTimeout(timer);
    installed = false;
  };
}

export const getCompactMode = () => mode;
export const isCompact = () => compact;

export function cycleCompactMode(): CompactMode {
  mode = mode === "auto" ? "on" : mode === "on" ? "off" : "auto";
  writeMode(mode);
  recompute();
  emit();
  return mode;
}

export function subscribeCompact(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
