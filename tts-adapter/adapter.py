#!/usr/bin/env python3
"""TTS adapter v2: Pithagoras portal Breeze-native JSON -> Kokoro OpenAI API.

v2 fixes (2026-09-18):
- Request NON-STREAMING PCM from Kokoro (stream:false). The v1 stream:true path
  received a chunked body whose framing bytes (hex size lines + CRLF, 0\r\n\r\n
  terminator) leaked into the "PCM" output -> burst of static in the browser
  -> "Network error". Non-streaming returns one clean Content-Length body.
- Hardened decode: if the body looks chunked (leading hex-size line or trailing
  0\r\n\r\n) it is decoded even when the header doesn't say so.
- Validates output (even length, no ASCII chunk markers, non-silent) before
  sending it on; sends X-Sample-Rate: 24000.
- Logs every request to docker logs (v1 was silent -> hard to debug).

Loopback-only, pure-stdlib. Raw-socket upstream because urllib/http.client
triggers Kokoro's 401 header-parser quirk (see skill pithagoras-210-voice-llm).
Production: pithagoras-tts-adapter (unless-stopped, boots automatically).
"""
import json, os, re, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("KOKORO_UPSTREAM", "http://127.0.0.1:7863").rstrip("/")
U_HOST, U_PORT = UPSTREAM.split("//")[1].rsplit(":", 1)
U_PORT = int(U_PORT)
KEY = os.environ.get("KOKORO_KEY", "")
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
PORT = int(os.environ.get("PORT", "7864"))
BIND = os.environ.get("BIND", "127.0.0.1")
CHUNK = 65536

# a hex chunk-size line: 1-8 hex digits + CRLF
CHUNK_HEAD_RE = re.compile(rb"^[0-9a-fA-F]{1,8}\r\n")


def _decode_chunked(buf):
    out = b""
    while True:
        nl = buf.find(b"\r\n")
        if nl == -1:
            break
        size_line = buf[:nl].decode(errors="replace").strip().split(";")[0]
        if not size_line:
            break
        try:
            size = int(size_line, 16)
        except ValueError:
            break
        buf = buf[nl + 2:]
        if size == 0:
            break
        out += buf[:size]
        buf = buf[size + 2:]
    return out


def _looks_chunked(b):
    return bool(CHUNK_HEAD_RE.match(b)) or b.endswith(b"0\r\n\r\n")


def call_upstream(text):
    """Non-streaming POST to Kokoro over a raw socket. -> (status, headers, body)."""
    body = json.dumps({"model": "kokoro", "input": text, "voice": VOICE,
                       "response_format": "pcm", "stream": False}).encode()
    req = (b"POST /v1/audio/speech HTTP/1.1\r\n"
           b"Host: " + U_HOST.encode() + b":" + str(U_PORT).encode() + b"\r\n"
           b"Content-Type: application/json\r\n"
           b"Authorization: *** " + KEY.encode() + b"\r\n"
           b"Content-Length: " + str(len(body)).encode() + b"\r\n"
           b"Connection: close\r\n\r\n" + body)
    s = socket.create_connection((U_HOST, U_PORT), timeout=180)
    s.sendall(req)
    raw = b""
    while True:
        d = s.recv(CHUNK)
        if not d:
            break
        raw += d
    s.close()
    if b"\r\n\r\n" not in raw:
        return 502, {}, b""
    head, _, bodybuf = raw.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for ln in lines[1:]:
        if b":" in ln:
            k, v = ln.split(b":", 1)
            headers[k.strip().lower()] = v.strip().decode(errors="replace")
    if "chunked" in headers.get("transfer-encoding", "").lower() or _looks_chunked(bodybuf):
        audio = _decode_chunked(bodybuf)
    else:
        audio = bodybuf
    return status, headers, audio


def _valid_pcm(a):
    if not a or len(a) % 2:
        return False
    if _looks_chunked(a):
        return False
    # non-silence check: at least some nonzero samples
    import struct
    n = len(a) // 2
    step = max(1, n // 5000)
    return any(struct.unpack_from("<h", a, i * 2)[0] != 0 for i in range(0, n, step))


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    _sent = False

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self._sent = True
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, json.dumps({"status": "ok", "engine": "kokoro-adapter-v2",
                                       "upstream": UPSTREAM, "voice": VOICE}).encode())
        else:
            self._send(404, b'{"error":"not found"}')

    def _read_request_body(self):
        cl = self.headers.get("Content-Length")
        if cl:
            return self.rfile.read(int(cl) or 0)
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            # portal fetch may send chunked request bodies
            out = b""
            while True:
                line = self.rfile.readline().strip()
                try:
                    size = int(line, 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline()
                    break
                out += self.rfile.read(size)
                self.rfile.readline()  # trailing CRLF
            return out
        return b""

    def do_POST(self):
        self._sent = False
        t0 = __import__("time").time()
        try:
            raw = self._read_request_body()
            body = json.loads(raw) if raw else {}
            text = body.get("input") or body.get("text") or ""
            print(f"POST /v1/audio/speech in={len(text)} chars", flush=True)
            if not text:
                self._send(400, b'{"error":"no text"}')
                return
            status, headers, audio = call_upstream(text)
            if status != 200 or not _valid_pcm(audio):
                print(f"  -> kokoro http={status} bytes={len(audio)} valid={_valid_pcm(audio)} "
                      f"ELAPSED={__import__('time').time()-t0:.2f}s  FAIL", flush=True)
                self._send(502, json.dumps({"error": "kokoro %d" % status}).encode())
                return
            print(f"  -> kokoro http={status} bytes={len(audio)} "
                  f"ELAPSED={__import__('time').time()-t0:.2f}s  OK", flush=True)
            self._send(200, audio, "audio/pcm", extra={"X-Sample-Rate": "24000"})
        except Exception as e:
            print(f"  -> EXCEPTION {e!r} ELAPSED={__import__('time').time()-t0:.2f}s", flush=True)
            if not self._sent:
                self._send(502, json.dumps({"error": str(e)}).encode())


if __name__ == "__main__":
    print(f"adapter v2 listening on {BIND}:{PORT} -> {UPSTREAM} (voice={VOICE}, non-streaming)", flush=True)
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
