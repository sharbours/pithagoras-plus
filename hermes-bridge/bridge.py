#!/usr/bin/env python3
"""
hermes-bridge — presents a llama.cpp-style face to Pithagoras's pi-llama-cpp
extension and proxies the actual chat calls to the Hermes Agent API server
(OpenAI-compatible, 192.168.0.197:8642).

WHY A BRIDGE
  pi-llama-cpp registers every server with api="openai-completions" and,
  during discovery, calls llama.cpp-specific endpoints that Hermes does not
  serve: GET /props, GET /props?model=, GET /models/sse (EventSource),
  POST /models/load|unload, and it POSTs chat to the RAW root
  (/chat/completions — the OpenAI SDK appends /chat/completions to the
  baseURL). Hermes serves /v1/* only. This shim emulates just enough of
  llama-server for discovery/status/load to succeed, then transparently
  proxies /chat/completions to Hermes's /v1/chat/completions (streaming and
  non-streaming), injecting the real API key.

ENDPOINTS SERVED (all on loopback :7865)
  GET  /health, /v1/health        -> {"status":"ok"}
  GET  /v1/models                 -> single-model list (id=hermes-agent)
  GET  /props[?model=...]         -> llama.cpp props; model always "loaded"
  POST /models/load, /models/unload -> 200 no-op (model always available)
  GET  /models/sse                -> SSE; immediate status_change "loaded"
  POST /chat/completions, /v1/chat/completions -> proxy to Hermes (passthrough)
  anything else                   -> JSON 404 (never HTML, so the client's
                                     res.json() can't throw)

SECURITY
  Binds 127.0.0.1 only. The Hermes API key is read from a 0600 file
  (HERMES_API_KEY_FILE) or env (HERMES_API_KEY) and is NEVER logged.
  Inbound Authorization headers from the portal are ignored (the portal
  only speaks to us on loopback); the real key is injected outbound.

ENV
  HERMES_API_URL       default http://192.168.0.197:8642
  HERMES_API_KEY_FILE  default /opt/pithagoras/hermes-bridge/.key
  BRIDGE_PORT          default 7865
"""
import http.client
import json
import os
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERMES_URL = os.environ.get("HERMES_API_URL", "http://192.168.0.197:8642")
HERMES_HOST, HERMES_PORT = (
    urllib.parse.urlsplit(HERMES_URL).hostname,
    int(urllib.parse.urlsplit(HERMES_URL).port or 8642),
)
PORT = int(os.environ.get("BRIDGE_PORT", "7865"))
KEY_FILE = os.environ.get("HERMES_API_KEY_FILE", "/opt/pithagoras/hermes-bridge/.key")

MODEL_ID = "hermes-agent"
MODEL_NAME = "Hermes Agent (.197)"


def load_key() -> str:
    env = os.environ.get("HERMES_API_KEY")
    if env:
        return env.strip()
    try:
        with open(KEY_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


OUTBOUND_CRED = load_key()  # read once at boot; injected only on the outbound call to Hermes

# --- static llama.cpp-shaped payloads -------------------------------------

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
    "build_info": "hermes-bridge/1.0",
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
    "build_info": "hermes-bridge/1.0",
    "is_sleeping": False,
    "cors_proxy_enabled": False,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-bridge/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers ------------------------------------------------------------
    def log_message(self, fmt, *args):  # quiet, structured, never leaks keys
        print(f"[hermes-bridge] {self.command} {self.path} -> {args[0] if args else '?'}", flush=True)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_404(self):
        self._send_json(
            {"error": {"code": 404, "message": "not found", "type": "api_error"}},
            404,
        )

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    # -- routes --------------------------------------------------------------
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
            if "model" in parts.query:
                self._send_json(PROPS_MODEL)
            else:
                self._send_json(PROPS)
            return
        if path == "/models/sse":
            self._sse_status()
            return
        self._send_404()

    def do_POST(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path.rstrip("/") or "/"
        body = self._read_body()
        if path in ("/models/load", "/models/unload"):
            self._send_json(MODELS_LIST)  # no-op: the model is always "loaded"
            return
        if path in ("/chat/completions", "/v1/chat/completions"):
            self._proxy_chat(body)
            return
        self._send_404()

    # -- chat proxy ----------------------------------------------------------
    def _proxy_chat(self, body: bytes):
        """Proxy to Hermes /v1/chat/completions.
        CRITICAL: forward the upstream framing header (Transfer-Encoding
        chunked for streams, Content-Length for JSON). Without it a
        keep-alive client cannot tell where the body ends and hangs —
        this was the 2026-09-18 'chat hangs 90s' bug."""
        try:
            conn = http.client.HTTPConnection(HERMES_HOST, HERMES_PORT, timeout=300)
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {OUTBOUND_CRED}",
            }
            conn.request("POST", "/v1/chat/completions", body=body, headers=headers)
            resp = conn.getresponse()

            self.send_response(resp.status)
            # Always close after this response: http.client has ALREADY
            # de-chunked the upstream body, so the bytes we write are raw
            # (decoded) — we CANNOT re-advertise Transfer-Encoding: chunked
            # (the client would parse SSE text as hex chunk sizes). Instead
            # we signal end-of-stream by closing the connection.
            self.send_header("Connection", "close")
            ct = resp.getheader("Content-Type") or "application/json"
            self.send_header("Content-Type", ct)
            te = resp.getheader("Transfer-Encoding")
            cl = resp.getheader("Content-Length")
            # Forward Content-Length only for bounded, non-chunked bodies.
            if cl and not (te and "chunked" in te.lower()):
                self.send_header("Content-Length", cl)
            self.end_headers()

            if te and "chunked" in te.lower():
                # Line-oriented read: Hermes's SSE frames end with \n, and
                # readline() returns as soon as a line completes (low
                # latency). The whole JSON body (non-stream) is also one
                # line, so this is correct for both. b"" == stream end.
                while True:
                    line = resp.readline()
                    if not line:
                        break
                    self.wfile.write(line)
                    self.wfile.flush()
            else:
                # bounded body: read() returns exactly len(body)
                self.wfile.write(resp.read())
            conn.close()
        except (BrokenPipeError, ConnectionResetError):
            pass  # client hung up mid-stream; nothing to do

    # -- SSE status stream ---------------------------------------------------
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
            # keep the EventSource alive like llama-server does
            while True:
                time.sleep(15)
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client disconnected


def main():
    if not OUTBOUND_CRED:
        print(f"[hermes-bridge] WARNING: no API key found ({KEY_FILE}); chat will 401", flush=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[hermes-bridge] listening on 127.0.0.1:{PORT} -> {HERMES_URL}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
