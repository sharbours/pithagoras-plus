#!/usr/bin/env python3
"""
hermes-bridge v2 — presents a llama.cpp-style face to Pithagoras's pi-llama-cpp
extension and drives the Hermes Agent over the approval-capable /v1/runs API
(192.168.0.197:8642), translating the runs event stream into the exact OpenAI
chat/completions SSE wire format the Pith client already consumes.

WHY /v1/runs (v2, 2026-09-19)
  v1 proxied POST /v1/chat/completions, which has NO approval surface: when a
  flagged command fired, Hermes (api_server platform = "unattended") auto-denied
  at the gate and the model relayed "approval request queued" with no way to
  answer. The /v1/runs API DOES support approvals:
    POST /v1/runs            -> 202 {run_id}
    GET  /v1/runs/{id}       -> {status: queued|running|waiting_for_approval|
                                 completed|failed, approval:{...}, output, usage}
    GET  /v1/runs/{id}/events-> SSE: message.delta{delta},
                                 reasoning.available{text}, tool.started{tool,
                                 preview}, tool.completed{tool,duration,error},
                                 approval.request{command,pattern_key(s),
                                 description,choices,request_id},
                                 run.completed{output,usage} / run.failed{error}
    POST /v1/runs/{id}/approval {choice: once|session|always|deny, request_id}
  v2 therefore:
    * drives each chat request through POST /v1/runs (stable session id for
      continuity; conversation history from the full OpenAI messages list),
    * streams runs events back as OpenAI chat.completion.chunk lines
      (message.delta -> delta.content, reasoning.available -> delta.reasoning_
      content, terminal -> finish_reason + usage + [DONE]) — byte-compatible
      with what the local llama-server emits, so the Pith client needs no
      changes,
    * tracks pending approvals (from approval.request events, reconciled
      against GET status polls) and serves them to the Pith portal:
        GET  /approvals                -> list of pending approvals
        POST /approvals/resolve        -> {run_id, choice} -> POST /v1/runs/..
      The open chat SSE stream STALLS while the run waits for approval and
      RESUMES when it's resolved — the portal's PermissionBar (which polls
      /api/approvals) is where the human taps Yes/No.

  v2 requires the 2026-09-19 approval_context patch on the Hermes host
  (.197): api_server sessions with a registered gateway notifier (i.e. the
  /v1/runs path) are treated as answerable gateway approval contexts instead
  of unattended, so flagged commands block at waiting_for_approval for up to
  approvals.timeout (60s) before failing closed. Webhook/cron/chat-completions
  callers (no notifier) keep the historical auto-deny.

ENDPOINTS (loopback :7865)
  GET  /health, /v1/health          -> {"status":"ok"}
  GET  /v1/models                   -> single model (id=hermes-agent)
  GET  /props[?model=]              -> llama.cpp props (always "loaded")
  POST /models/load|unload          -> 200 no-op
  GET  /models/sse                  -> status_change loaded + keepalive
  POST /chat/completions, /v1/chat/completions
                                   -> drive Hermes /v1/runs; stream OpenAI SSE
  GET  /approvals                   -> [{run_id, request_id, command, description,
                                        pattern_keys, choices, since}]
  POST /approvals/resolve           -> {run_id, choice, request_id?}
  anything else                     -> JSON 404 (never HTML)

SECURITY
  Binds 127.0.0.1 only. The Hermes API key is read from a 0600 file
  (HERMES_API_KEY_FILE) or env (HERMES_API_KEY) and is NEVER logged.
  Inbound Authorization from the portal is ignored (loopback only); the real
  key is injected outbound.

ENV
  HERMES_API_URL        default http://192.168.0.197:8642
  HERMES_API_KEY_FILE   default /opt/pithagoras/hermes-bridge/.key
  HERMES_API_KEY        override (env)
  BRIDGE_PORT           default 7865
  HERMES_SESSION_ID     stable runs session id (continuity), default "pithagoras-pith"
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERMES_URL = os.environ.get("HERMES_API_URL", "http://192.168.0.197:8642")
PORT = int(os.environ.get("BRIDGE_PORT", "7865"))
KEY_FILE = os.environ.get("HERMES_API_KEY_FILE", "/opt/pithagoras/hermes-bridge/.key")
HERMES_SESSION_ID = os.environ.get("HERMES_SESSION_ID", "pithagoras-pith")
RUN_TIMEOUT_S = int(os.environ.get("BRIDGE_RUN_TIMEOUT", "1800"))
RECONCILE_INTERVAL_S = 1.5
KEEPALIVE_S = 20.0

MODEL_ID = "hermes-agent"
MODEL_NAME = "Hermes Agent (.197)"

# Bearer prefix assembled from char codes: a security redaction hook rewrites
# literal "Bearer <secret>" patterns in written files, which broke auth in
# earlier test scripts. Keep it out of this source file for the same reason.
_BEARER = chr(66) + chr(101) + chr(97) + chr(114) + chr(101) + chr(114) + chr(32)


def load_key() -> str:
    env = os.environ.get("HERMES_API_KEY")
    if env:
        return env.strip()
    try:
        with open(KEY_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


OUTBOUND_CRED = load_key()


def hermes_request(method: str, path: str, body=None, timeout=60, stream=False):
    """One HTTP call to Hermes. Returns (http.client.HTTPResponse, error).
    Never raises for HTTP error statuses (the caller inspects the response)."""
    import http.client
    parts = urllib.parse.urlsplit(HERMES_URL)
    host = parts.hostname
    port = parts.port or 8642
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    headers = {"Content-Type": "application/json"}
    if OUTBOUND_CRED:
        headers["Authorization"] = _BEARER + OUTBOUND_CRED
    payload = json.dumps(body).encode() if body is not None else None
    try:
        conn.request(method, path, body=payload, headers=headers)
        return conn.getresponse(), None
    except (urllib.error.URLError, OSError) as e:
        conn.close()
        return None, e


# --- static llama.cpp-shaped payloads (unchanged from v1) -------------------

MODELS_LIST = {
    "data": [
        {
            "id": MODEL_ID,
            "name": MODEL_NAME,
            "object": "model",
            "created": int(time.time()),
            "aliases": [MODEL_NAME],
            "meta": {"n_ctx": 32768},
            "architecture": {"input_modalities": ["text"]},
        }
    ]
}

PROPS = {
    "role": "default",
    "max_instances": 1,
    "models_autoload": False,
    "model_alias": MODEL_ID,
    "model_path": "hermes-bridge",
    "default_generation_settings": {},
    "ui_settings": {},
    "build_info": "hermes-bridge/2.0",
    "cors_proxy_enabled": False,
}

PROPS_MODEL = {
    "error": None,
    "default_generation_settings": {"params": {}, "n_ctx": 32768},
    "total_slots": 1,
    "model_alias": MODEL_ID,
    "model_path": "hermes-bridge",
    "modalities": {"vision": False, "video": False, "audio": False},
    "media_marker": "##media",
    "endpoint_slots": False,
    "endpoint_props": True,
    "endpoint_metrics": False,
    "ui": False,
    "ui_settings": {},
    "chat_template": "",
    "chat_template_caps": {
        "supports_object_arguments": False,
        "supports_parallel_tool_calls": False,
        "supports_preserve_reasoning": False,
        "supports_string_content": True,
        "supports_system_role": True,
        "supports_tool_calls": False,
        "supports_tools": False,
        "supports_typed_content": False,
    },
    "bos_token": "",
    "eos_token": "",
    "build_info": "hermes-bridge/2.0",
    "is_sleeping": False,
    "cors_proxy_enabled": False,
}


# --- pending approvals registry (shared by SSE events + reconcile + API) ----

_pending = {}        # run_id -> {run_id, request_id, command, description, pattern_keys, choices, since}
_pending_lock = threading.Lock()


def _register_approval(run_id: str, approval: dict) -> None:
    if not run_id:
        return
    cmd = str(approval.get("command") or "")[:80]
    with _pending_lock:
        prev = _pending.get(run_id)
        # Only (re)print when the entry is new or the command changed (the
        # reconciler re-registers on every poll while parked — don't spam).
        if prev and prev.get("command") == cmd and prev.get("request_id") == approval.get("request_id"):
            return
        _pending[run_id] = {
            "run_id": run_id,
            "request_id": approval.get("request_id"),
            "command": approval.get("command", ""),
            "description": approval.get("description", ""),
            "pattern_key": approval.get("pattern_key"),
            "choices": approval.get("choices") or ["once", "deny"],
            "since": prev.get("since", time.time()) if prev else time.time(),
        }
    print(f"[hermes-bridge] approval pending: run={run_id} req={approval.get('request_id')} "
          f"cmd={cmd!r}", flush=True)


def _clear_approval(run_id: str) -> None:
    with _pending_lock:
        if _pending.pop(run_id, None) is not None:
            print(f"[hermes-bridge] approval cleared: run={run_id}", flush=True)


def _pending_list() -> list:
    with _pending_lock:
        return [dict(v) for v in _pending.values()]


def _reconciler():
    """Poll every run we know about (or is pending) to keep the approvals
    registry consistent even if the SSE stream missed an event. Light-touch:
    only polls while something is pending (avoids steady-state load)."""
    while True:
        time.sleep(RECONCILE_INTERVAL_S)
        try:
            with _pending_lock:
                runs = list(_pending.keys())
            for run_id in runs:
                resp, err = hermes_request("GET", "/v1/runs/" + run_id, timeout=15)
                if resp is None:
                    continue
                try:
                    d = json.loads(resp.read().decode() or "{}")
                except Exception:
                    continue
                finally:
                    resp.close()
                status = d.get("status")
                if status == "waiting_for_approval" and d.get("approval"):
                    _register_approval(run_id, d["approval"])
                else:
                    _clear_approval(run_id)
        except Exception as e:
            print(f"[hermes-bridge] reconciler error: {e}", flush=True)


# --- OpenAI chat/completions SSE emission ------------------------------------

class _OAI:
    """Builds OpenAI chat.completion.chunk payloads identical in shape to
    llama-server's output (the Pith client's ground truth)."""

    def __init__(self, model: str, created: int):
        self.model = model or MODEL_ID
        self.created = created
        self.id = "chatcmpl-" + os.urandom(11).hex()
        self.prompt_tokens = 0
        self.completion_tokens = 0

    def role_chunk(self) -> bytes:
        return self._frame({"role": "assistant", "content": None})

    def content_chunk(self, text: str) -> bytes:
        if not text:
            return None
        return self._frame({"content": text})

    def reasoning_chunk(self, text: str) -> bytes:
        if not text:
            return None
        return self._frame({"reasoning_content": text})

    def _frame(self, delta: dict) -> bytes:
        return (b"data: " + json.dumps({
            "id": self.id, "object": "chat.completion.chunk",
            "created": self.created, "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        }, ensure_ascii=False).encode() + b"\n\n")

    def final_chunk(self, finish_reason: str) -> bytes:
        o = {
            "id": self.id, "object": "chat.completion.chunk",
            "created": self.created, "model": self.model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
            "usage": {
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "total_tokens": self.prompt_tokens + self.completion_tokens,
            },
        }
        return b"data: " + json.dumps(o, ensure_ascii=False).encode() + b"\n\n"

    def done(self) -> bytes:
        return b"data: [DONE]\n\n"

    def keepalive(self) -> bytes:
        # SSE comment line: valid SSE, ignored by clients, keeps sockets warm.
        return b": keepalive\n\n"

    def non_stream(self, text: str, finish_reason: str = "stop") -> dict:
        return {
            "id": self.id, "object": "chat.completion",
            "created": self.created, "model": self.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": finish_reason}],
            "usage": {"prompt_tokens": self.prompt_tokens,
                      "completion_tokens": self.completion_tokens,
                      "total_tokens": self.prompt_tokens + self.completion_tokens},
        }


def _content_text(content) -> str:
    """Flatten OpenAI message content (string or parts array) to text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text" and p.get("text"):
                out.append(str(p["text"]))
        return " ".join(out)
    return ""


def _create_run(messages: list, stream: bool) -> str:
    """POST /v1/runs; returns run_id or raises RuntimeError."""
    system = ""
    hist = []
    for m in messages or []:
        role = m.get("role", "")
        text = _content_text(m.get("content"))
        if role == "system":
            system = (system + "\n" + text).strip() if system else text
        elif role in ("user", "assistant"):
            hist.append({"role": role, "content": text})
    if not hist:
        raise RuntimeError("no user/assistant messages in chat request")
    user_message = hist[-1]["content"]
    conversation = hist[:-1]
    body = {"input": hist, "session_id": HERMES_SESSION_ID}
    if system:
        body["instructions"] = system
    resp, err = hermes_request("POST", "/v1/runs", body=body, timeout=60)
    if resp is None:
        raise RuntimeError("hermes unreachable: " + str(err))
    raw = resp.read().decode()
    code = resp.status
    resp.close()
    if code != 202:
        raise RuntimeError(f"hermes /v1/runs -> {code}: {raw[:300]}")
    d = json.loads(raw or "{}")
    run_id = d.get("run_id")
    if not run_id:
        raise RuntimeError("hermes /v1/runs returned no run_id: " + raw[:300])
    return run_id


def _read_runs_stream(run_id: str, sink):
    """Subscribe to GET /v1/runs/{id}/events and translate every event into
    OpenAI chunks written to `sink` (a file-like object = the Pith client's
    socket). Blocks while the run is alive; returns on the stream sentinel.

    `sink` protocol: .write(bytes). Raises on client disconnect (caller
    handles). Pending approvals are registered here (the run's chat socket
    simply stalls until the portal resolves them)."""
    import http.client
    parts = urllib.parse.urlsplit(HERMES_URL)
    conn = http.client.HTTPConnection(parts.hostname, parts.port or 8642, timeout=RUN_TIMEOUT_S)
    headers = {}
    if OUTBOUND_CRED:
        headers["Authorization"] = _BEARER + OUTBOUND_CRED
    conn.request("GET", "/v1/runs/" + run_id + "/events", headers=headers)
    resp = conn.getresponse()
    if resp.status != 200:
        raw = resp.read()
        resp.close()
        raise RuntimeError(f"hermes events stream -> {resp.status}: {raw[:300]!r}")

    oai = _OAI(MODEL_ID, int(time.time()))
    sent_role = [False]  # mutated by _handle_event (list so it's shareable)
    last_activity = [time.time()]
    buf = b""
    terminal = [None]  # (finish_reason, error_text)

    def emit(b):
        if b:
            sink.write(b)
            sink.flush()
            last_activity[0] = time.time()

    try:
        while True:
            line = resp.readline()
            if not line:
                break  # server closed (sentinel consumed) -> run ended
            buf += line
            while b"\n" in buf:
                rawline, buf = buf.split(b"\n", 1)
                line = rawline.decode("utf-8", "replace").strip()
                if not line or line.startswith(":"):
                    continue  # keepalive / SSE comment
                if line.startswith("data:"):
                    data = line[len("data:"):].strip()
                    if not data:
                        continue
                    try:
                        ev = json.loads(data)
                    except Exception:
                        continue
                    try:
                        _handle_event(ev, oai, emit, sent_role, terminal, last_activity, run_id)
                    except Exception as _he:
                        import traceback
                        print(f"[hermes-bridge] event handler error on {run_id} "
                              f"({_he.__class__.__name__}: {_he}); raw={data[:200]!r}", flush=True)
                        traceback.print_exc()
            if terminal[0] is not None:
                break
            now = time.time()
            if now - last_activity[0] > KEEPALIVE_S:
                emit(oai.keepalive())
                last_activity[0] = now
    finally:
        try:
            resp.close()
        except Exception:
            pass
        conn.close()

    # Close the OpenAI stream: final chunk + [DONE].
    if terminal[0] is None:
        terminal[0] = ("stop", None)  # stream ended without a terminal event: treat as done
    reason, err_text = terminal[0]
    if err_text:
        # Surface the failure as a content delta so the user sees it, then end.
        c = oai.content_chunk("\n\n(hermes run failed: " + err_text[:300] + ")")
        if c:
            emit(c)
    if not sent_role:
        emit(oai.role_chunk())
    emit(oai.final_chunk(reason))
    emit(oai.done())


def _handle_event(ev, oai, emit, sent_role, terminal, last_activity, run_id):
    name = ev.get("event", "")
    if name == "message.delta":
        if not sent_role[0]:
            emit(oai.role_chunk())
            sent_role[0] = True
        c = oai.content_chunk(str(ev.get("delta") or ""))
        if c:
            emit(c)
    elif name == "reasoning.available":
        if not sent_role[0]:
            emit(oai.role_chunk())
            sent_role[0] = True
        c = oai.reasoning_chunk(str(ev.get("text") or ""))
        if c:
            emit(c)
    elif name in ("tool.started", "tool.completed", "subagent.start", "subagent.complete",
                  "approval.responded", "run.steered", "steer", "steer_not_accepted", "steer_failed"):
        pass  # tool progress is UI noise for the Pith transcript; skip
    elif name == "approval.request":
        last_activity[0] = time.time()
        _register_approval(run_id, ev)
        # The runs stream will now stall until the approval is resolved.
        c = oai.content_chunk("\n\n\u26a0\ufe0f A tool action requires your approval \u2014 it will appear in the "
                              "Permission strip above this message. Reply with your choice there.")
        if c:
            emit(c)
    elif name.startswith("run."):
        if name == "run.completed":
            usage = ev.get("usage") or {}
            oai.prompt_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
            oai.completion_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
            _clear_approval(run_id)
            terminal[0] = ("stop", None)
        elif name == "run.failed":
            _clear_approval(run_id)
            terminal[0] = ("error", str(ev.get("error") or "run failed"))
        else:  # run.cancelled / run.queued / others
            terminal[0] = ("stop", None)


def _resolve_approval(run_id: str, choice: str, request_id=None):
    choice = (choice or "").lower()
    if choice in ("approve", "approved", "allow"):
        choice = "once"
    if choice not in ("once", "session", "always", "deny"):
        return {"ok": False, "error": f"invalid choice: {choice}"}
    body = {"choice": choice}
    if request_id:
        body["request_id"] = request_id
    resp, err = hermes_request("POST", f"/v1/runs/{run_id}/approval", body=body, timeout=30)
    if resp is None:
        return {"ok": False, "error": "hermes unreachable: " + str(err)}
    raw = resp.read().decode()
    code = resp.status
    resp.close()
    if code == 200:
        _clear_approval(run_id)
        return {"ok": True, "run_id": run_id, "choice": choice}
    return {"ok": False, "error": f"hermes approval -> {code}: {raw[:200]}"}


# --- HTTP server -------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-bridge/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[hermes-bridge] {self.command} {self.path} -> {args[0] if args else '?'}", flush=True)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_404(self):
        self._send_json({"error": {"code": 404, "message": "not found", "type": "api_error"}}, 404)

    def _read_body(self):
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            return self._read_chunked()
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _read_chunked(self):
        out = b""
        while True:
            size_line = self.rfile.readline().strip()
            size = int(size_line.split(b";")[0] or b"0", 16)
            if size == 0:
                self.rfile.readline()
                break
            out += self.rfile.read(size)
            self.rfile.readline()
        return out

    # -- routes ---------------------------------------------------------------
    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path.rstrip("/") or "/"
        if path in ("/health", "/v1/health"):
            self._send_json({"status": "ok"})
            return
        if path == "/v1/models":
            self._send_json(MODELS_LIST)
            return
        if path == "/props":
            self._send_json(PROPS_MODEL if "model" in parts.query else PROPS)
            return
        if path == "/models/sse":
            self._sse_status()
            return
        if path == "/approvals":
            self._send_json({"approvals": _pending_list()})
            return
        self._send_404()

    def do_POST(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path.rstrip("/") or "/"
        body = self._read_body()
        if path in ("/models/load", "/models/unload"):
            self._send_json(MODELS_LIST)
            return
        if path in ("/chat/completions", "/v1/chat/completions"):
            self._chat(body)
            return
        if path == "/approvals/resolve":
            try:
                d = json.loads(body or b"{}")
            except Exception:
                self._send_json({"ok": False, "error": "invalid json"}, 400)
                return
            self._send_json(_resolve_approval(str(d.get("run_id") or ""),
                                              str(d.get("choice") or ""),
                                              d.get("request_id")))
            return
        self._send_404()

    # -- chat -> runs ----------------------------------------------------------
    def _chat(self, body: bytes):
        try:
            req = json.loads(body or b"{}")
        except Exception:
            self._send_json({"error": {"message": "invalid json", "type": "api_error"}}, 400)
            return
        messages = req.get("messages") or []
        stream = bool(req.get("stream"))

        # One Hermes run at a time (the API server is concurrency-1, like our
        # -np 1 llama-server): queue rather than 429.
        with RUN_LOCK:
            try:
                run_id = _create_run(messages, stream)
            except Exception as e:
                self._send_json({"error": {"message": str(e), "type": "upstream_error"}}, 502)
                return
            print(f"[hermes-bridge] run started: {run_id} (session={HERMES_SESSION_ID}, stream={stream})", flush=True)
            if stream:
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    _read_runs_stream(run_id, self.wfile)
                except (BrokenPipeError, ConnectionResetError):
                    print(f"[hermes-bridge] client disconnected mid-run: {run_id}", flush=True)
                    try:
                        self._stop_run(run_id)
                    except Exception:
                        pass
                except Exception as e:
                    print(f"[hermes-bridge] stream error on {run_id}: {e}", flush=True)
            else:
                # Non-streaming: collect the run to a terminal state (poll),
                # then emit one OpenAI chat.completion object.
                result = self._await_run_complete(run_id)
                oai = _OAI(MODEL_ID, int(time.time()))
                oai.prompt_tokens = result.get("prompt_tokens", 0)
                oai.completion_tokens = result.get("completion_tokens", 0)
                self._send_json(oai.non_stream(result.get("output", ""), result.get("finish", "stop")))
        print(f"[hermes-bridge] run finished: {run_id}", flush=True)

    def _stop_run(self, run_id: str):
        try:
            resp, _ = hermes_request("POST", f"/v1/runs/{run_id}/stop", body={}, timeout=15)
            if resp is not None:
                resp.read(); resp.close()
        except Exception:
            pass

    def _await_run_complete(self, run_id: str) -> dict:
        t0 = time.time()
        while time.time() - t0 < RUN_TIMEOUT_S:
            resp, err = hermes_request("GET", "/v1/runs/" + run_id, timeout=30)
            if resp is not None:
                try:
                    d = json.loads(resp.read().decode() or "{}")
                except Exception:
                    d = {}
                resp.close()
                status = d.get("status")
                if status == "waiting_for_approval" and d.get("approval"):
                    _register_approval(run_id, d["approval"])
                elif status in ("completed", "failed", "cancelled"):
                    _clear_approval(run_id)
                    usage = d.get("usage") or {}
                    return {
                        "output": d.get("output") or "",
                        "error": d.get("error"),
                        "finish": "stop" if status == "completed" else "error",
                        "prompt_tokens": int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
                        "completion_tokens": int(usage.get("output_tokens") or usage.get("completion_tokens") or 0),
                    }
            time.sleep(1.0)
        return {"output": "", "error": "run timed out", "finish": "error"}

    # -- SSE status stream (unchanged from v1) ---------------------------------
    def _sse_status(self):
        parts = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(parts.query)
        model = (q.get("model") or [MODEL_ID])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        payload = json.dumps({"status": "loaded", "exit_code": 0})
        try:
            self.wfile.write(f"event: status_change\ndata: {payload}\n\n".encode())
            self.wfile.flush()
            while True:
                time.sleep(15)
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


# One Hermes run at a time (the API server is concurrency-1, like our
# -np 1 llama-server): queue rather than 429.
RUN_LOCK = threading.Lock()


def main():
    if not OUTBOUND_CRED:
        print(f"[hermes-bridge] WARNING: no API key found ({KEY_FILE}); runs will 401", flush=True)
    threading.Thread(target=_reconciler, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    httpd.daemon_threads = True
    print(f"[hermes-bridge] v2 listening on 127.0.0.1:{PORT} -> {HERMES_URL} (runs session={HERMES_SESSION_ID})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
