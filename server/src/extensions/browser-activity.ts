/**
 * Browser activity, seen from the browser itself.
 *
 * The voice stage opens the browser window when the agent uses the browser. For pi that
 * shows up as browser tool events in the session. A brain whose tools run somewhere else —
 * Hermes on another host, driving this browser over the debugging protocol — leaves no
 * such events, so the window would stay shut while it browses. The portal therefore also
 * watches the browser: a tab arriving at a new real page counts as activity, whoever
 * caused it.
 *
 * Polling the debugging endpoint's tab list is enough for "something is browsing" and
 * needs no connection to keep alive. BROWSER_ACTIVITY=false turns it off.
 */
const CDP = process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222";
const POLL_MS = Math.max(500, Number(process.env.BROWSER_ACTIVITY_POLL_MS) || 1500);
/** Blank tabs, the new-tab page and browser internals are not "going somewhere". */
const IGNORED = /^(about:|chrome:|chrome-untrusted:|chrome-search:|chrome-extension:|devtools:|edge:|data:)/i;

let count = 0, at = 0, lastUrl = "";
let known: Map<string, string> | null = null;
let timer: NodeJS.Timeout | undefined;

async function poll(): Promise<void> {
  try {
    const response = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(String(response.status));
    const targets = (await response.json()) as Array<{ id: string; type: string; url: string }>;
    const pages = new Map(targets.filter(t => t.type === "page").map(t => [t.id, t.url]));
    if (known) {
      for (const [id, url] of pages) {
        if (IGNORED.test(url) || known.get(id) === url) continue;
        count++; at = Date.now(); lastUrl = url;
      }
    }
    known = pages;
  } catch {
    // Unreachable (stopped, restarting, tunnel down): start again from whatever is open when
    // it returns, so a restart restoring its tabs is not mistaken for browsing.
    known = null;
  }
}

export function watchBrowserActivity(): void {
  if (timer || process.env.BROWSER_ACTIVITY === "false") return;
  timer = setInterval(() => void poll(), POLL_MS);
  timer.unref?.();
  void poll();
}

/** A counter that rises with each navigation, when it last rose, and the page it went to. */
export function browserActivity() {
  return { count, at, url: lastUrl };
}
