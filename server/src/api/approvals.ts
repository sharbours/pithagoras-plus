import { Router } from "express";
import { readPiSettings } from "../pi-settings.js";

/**
 * Approvals proxy — lets the portal's permanent PermissionBar resolve Hermes
 * tool-permission requests that arrive while a run is parked in
 * waiting_for_approval.
 *
 * The portal never talks to the Hermes API server directly; it proxies to the
 * hermes-bridge on loopback (the same loopback service the pi-llama-cpp
 * extension's "hermes" llama-server points at, read live from pi's
 * settings.json so a test portal pointing at a test bridge port works
 * without code changes).
 *
 *   GET  /api/approvals               -> { approvals: [...] }   (empty when idle)
 *   POST /api/approvals/resolve       -> { run_id, choice: "once" | "always" | "deny" }
 *
 * A bridge that is down yields an empty list (idle) on GET and a 502 on
 * resolve — the bar simply shows "idle" until the bridge is back.
 */

interface BridgeApproval {
  run_id: string;
  request_id?: string | null;
  command?: string;
  description?: string;
  pattern_key?: string | null;
  choices?: string[];
  since?: number;
}

/** The hermes-bridge URL this portal's Hermes brain talks to (loopback). */
function bridgeBase(): string | null {
  const servers = (readPiSettings().llamaSettings as { servers?: { id?: string; url?: string }[] } | undefined)?.servers;
  const hermes = servers?.find((s) => s?.id === "hermes");
  const url = hermes?.url ?? "";
  return /^https?:\/\//.test(url) ? url : null;
}

function parseJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

export function approvalsRouter(): Router {
  const router = Router();

  router.get("/approvals", async (_req, res) => {
    const base = bridgeBase();
    if (!base) return res.json({ approvals: [] });
    try {
      const r = await fetch(`${base}/approvals`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return res.json({ approvals: [] });
      const d = await parseJson(r);
      const list = Array.isArray(d?.approvals) ? (d.approvals as BridgeApproval[]) : [];
      res.json({
        approvals: list.map((a) => ({
          runId: a.run_id,
          requestId: a.request_id ?? null,
          command: a.command ?? "",
          description: a.description ?? "",
          patternKey: a.pattern_key ?? null,
          choices: a.choices ?? ["once", "deny"],
          since: a.since ?? 0,
        })),
      });
    } catch {
      res.json({ approvals: [] });
    }
  });

  router.post("/approvals/resolve", async (req, res) => {
    const base = bridgeBase();
    if (!base) return res.status(502).json({ error: "Hermes bridge not configured" });
    const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
    const choice = typeof req.body?.choice === "string" ? req.body.choice.trim().toLowerCase() : "";
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    if (!runId) return res.status(400).json({ error: "runId is required" });
    if (!["once", "always", "deny", "session"].includes(choice)) {
      return res.status(400).json({ error: "choice must be once, always, session or deny" });
    }
    try {
      const r = await fetch(`${base}/approvals/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, choice, ...(requestId ? { request_id: requestId } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
      const d = await parseJson(r);
      if (!r.ok || d?.ok === false) {
        return res.status(502).json({ error: d?.error || `bridge returned ${r.status}` });
      }
      res.json({ ok: true, runId, choice });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message || "bridge unreachable" });
    }
  });

  return router;
}
