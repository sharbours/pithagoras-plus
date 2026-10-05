#!/usr/bin/env python3
"""TTS adapter v2: Pithagoras portal Breeze-native JSON -> upstream OpenAI TTS API.

v2 fixes (2026-09-18):
- Request NON-STREAMING PCM from the upstream (stream:false). The v1 stream:true
  path received a chunked body whose framing bytes (hex size lines + CRLF, 0\r\n\r\n
  terminator) leaked into the "PCM" output -> burst of static in the browser
  -> "Network error". Non-streaming returns one clean Content-Length body.
- Hardened decode: if the body looks chunked (leading hex-size line or trailing
  0\r\n\r\n) it is decoded even when the header doesn't say so.
- Validates output (even length, no ASCII chunk markers, non-silent) before
  sending it on; sends X-Sample-Rate: 24000.
- Logs every request to the container log (v1 was silent -> hard to debug).

Upstream engine (build #61, 2026-10-05): by default the upstream is Kokoro
(hwdsl2/kokoro-server, :7863, model "kokoro", voices af_heart/...). Setting
TTS_ENGINE=qwen3 re-points it at a Qwen3-TTS OpenAI-compatible server
(groxaxo/Qwen3-TTS-Openai-Fastapi, TTS_BACKEND=official, model "tts-1") which
serves the same /v1/audio/speech contract and the same 16-bit LE PCM @ 24 kHz.
Qwen3 has 9 preset speakers (Vivian/Serena/Sohee/...); the avatar menu lists
those speakers, and this adapter translates between the two engines' voice
id spaces so the same menu works no matter which engine is live (build #61
voice-menu, 2026-10-05):
  - qwen3 engine: Qwen3 ids pass through; legacy Kokoro ids use VOICE_MAP
    (JSON env), anything else falls back to QWEN_DEFAULT_VOICE.
  - kokoro engine: Qwen3 ids are reversed through VOICE_MAP to their Kokoro
    voice (vivian -> af_heart, ...); everything else passes straight through,
    so a Kokoro-only deployment never setting these env vars stays
    byte-identical to the pre-#61 adapter.

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

# ---------------------------------------------------------------------------
# Upstream engine (build #61 PoC: Qwen3-TTS 1.7B replaces Kokoro)
#
# TTS_ENGINE=kokoro (default, unchanged behavior) or TTS_ENGINE=qwen3.
# The Qwen3-TTS OpenAI-compatible server (groxaxo/Qwen3-TTS-Openai-Fastapi,
# TTS_BACKEND=official) speaks the same /v1/audio/speech contract as Kokoro
# and returns identical 16-bit LE PCM @ 24 kHz, so this adapter's wire path
# is unchanged; only the voice ids and the request "model" differ:
#   - voice: the portal sends either Qwen3 preset speaker ids (vivian,
#     serena, ... — the current avatar menu lists exactly these) or legacy
#     Kokoro ids (af_heart, ...). The mapping is bidirectional (see
#     map_voice): qwen3 engine passes Qwen ids through and maps Kokoro ids
#     onto speakers; kokoro engine reverses Qwen ids onto their Kokoro
#     voice. Either engine's own native ids pass straight through.
#   - model: Kokoro wants "kokoro"; the Qwen router wants "tts-1".
# ---------------------------------------------------------------------------
ENGINE = os.environ.get("TTS_ENGINE", "kokoro").strip().lower()
if ENGINE not in ("kokoro", "qwen3"):
    print(f"WARNING: unknown TTS_ENGINE={ENGINE!r}; using kokoro", flush=True)
    ENGINE = "kokoro"
QWEN_DEFAULT_VOICE = os.environ.get("QWEN_DEFAULT_VOICE", "Vivian")

def _load_voice_map():
    raw = os.environ.get("VOICE_MAP", "")
    if not raw:
        return {}
    try:
        m = json.loads(raw)
        return {str(k): str(v) for k, v in m.items()} if isinstance(m, dict) else {}
    except ValueError as e:
        print(f"WARNING: VOICE_MAP is not valid JSON ({e}); ignoring", flush=True)
        return {}

VOICE_MAP = _load_voice_map()

# The Qwen3-TTS 12Hz 1.7B-CustomVoice preset speakers (canonical lowercase,
# as returned by the wrapper's /v1/voices). The avatar menu lists exactly
# these, so under the qwen3 engine they pass through unchanged.
QWEN_NATIVE = frozenset({
    "vivian", "serena", "uncle_fu", "dylan", "eric",
    "ryan", "aiden", "ono_anna", "sohee",
})

# Reverse of VOICE_MAP: Qwen speaker -> Kokoro voice, for the kokoro engine
# (a reboot restores Kokoro, and the menu still offers Qwen ids, so vivian
# must become a real Kokoro voice instead of being sent verbatim).
QWEN_REVERSE = {v: k for k, v in VOICE_MAP.items()}

def map_voice(voice):
    """Map an incoming voice id to the upstream's speaker name.

    qwen3 engine:  Qwen3 preset ids pass through; legacy Kokoro ids use
        VOICE_MAP; anything else falls back to QWEN_DEFAULT_VOICE.
    kokoro engine: Qwen3 preset ids are reversed to their Kokoro voice
        (vivian -> af_heart, ...); Kokoro ids and anything else pass
        straight through, so a Kokoro-only deployment is unchanged."""
    if not voice:
        return voice
    if ENGINE == "qwen3":
        if voice in QWEN_NATIVE:
            return voice
        return VOICE_MAP.get(voice, QWEN_DEFAULT_VOICE)
    if voice in QWEN_NATIVE:
        return QWEN_REVERSE.get(voice, VOICE)
    return voice

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


# A Kokoro voice id (af_heart, am_adam, ...) or an OpenAI alias (coral, nova, ...).
# Strict whitelist: letters/digits/hyphen/underscore only, so a stray value can
# never inject a field into the Kokoro request or log a secret.
VOICE_ID_RE = re.compile(r"[a-zA-Z0-9_-]{1,32}")


def call_upstream(text, voice=""):
    """Non-streaming POST to the upstream TTS (Kokoro or Qwen3-TTS) over a raw
    socket. -> (status, headers, body).

    voice: an optional per-request voice id (Kokoro id, or Qwen speaker for a
    qwen3 engine); empty falls back to the VOICE env default. The upstream
    "model" and the voice value are engine-adjusted: the Qwen router wants
    model "tts-1" and its preset speaker names, Kokoro wants "kokoro" and its
    own ids. The raw-socket body is otherwise identical (same PCM contract)."""
    eff_voice = map_voice(voice or VOICE)
    model = "tts-1" if ENGINE == "qwen3" else "kokoro"
    body = json.dumps({"model": model, "input": text, "voice": eff_voice,
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
            self._send(200, json.dumps({"status": "ok", "engine": "tts-adapter-v2",
                                       "upstream": UPSTREAM, "tts_engine": ENGINE,
                                       "voice": VOICE, "voice_map": VOICE_MAP,
                                       "qwen_native": sorted(QWEN_NATIVE),
                                       "qwen_reverse": QWEN_REVERSE}).encode())
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
            voice = body.get("voice") or ""
            if voice and not VOICE_ID_RE.fullmatch(voice):
                print(f"POST /v1/audio/speech voice={voice!r} REJECTED (not a voice id)", flush=True)
                self._send(400, json.dumps({"error": "voice must be a Kokoro voice id like af_heart"}).encode())
                return
            print(f"POST /v1/audio/speech in={len(text)} chars voice={voice or VOICE}"
                  + (f" ->{map_voice(voice or VOICE)}" if ENGINE == "qwen3" else ""), flush=True)
            if not text:
                self._send(400, b'{"error":"no text"}')
                return
            status, headers, audio = call_upstream(text, voice)
            if status != 200 or not _valid_pcm(audio):
                print(f"  -> {ENGINE} http={status} bytes={len(audio)} valid={_valid_pcm(audio)} "
                      f"ELAPSED={__import__('time').time()-t0:.2f}s  FAIL", flush=True)
                self._send(502, json.dumps({"error": "%s %d" % (ENGINE, status)}).encode())
                return
            print(f"  -> {ENGINE} http={status} bytes={len(audio)} "
                  f"ELAPSED={__import__('time').time()-t0:.2f}s  OK", flush=True)
            self._send(200, audio, "audio/pcm", extra={"X-Sample-Rate": "24000"})
        except Exception as e:
            print(f"  -> EXCEPTION {e!r} ELAPSED={__import__('time').time()-t0:.2f}s", flush=True)
            if not self._sent:
                self._send(502, json.dumps({"error": str(e)}).encode())


if __name__ == "__main__":
    print(f"adapter v2 listening on {BIND}:{PORT} -> {UPSTREAM} (voice={VOICE}, non-streaming)", flush=True)
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
