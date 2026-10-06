#!/usr/bin/env python3
"""TTS adapter v3: Pithagoras portal Breeze-native JSON -> upstream OpenAI TTS API.

v3 (2026-10-06, voice cloning option A):
- New clone routing: a per-request voice id of the form "clone:<name>" is sent
  to a SECOND upstream — the 1.7B-Base clone engine (env QWEN_BASE_UPSTREAM,
  default http://127.0.0.1:7869, CPU-resident) — while every other voice id
  continues to the primary upstream (presets on the GPU CustomVoice, or Kokoro
  after a reboot). The "clone:" id passes through verbatim; the Base server's
  voice library (/opt/qwen3-tts/voice_library/profiles) resolves it. Both
  engines return the same 16-bit LE PCM @ 24 kHz contract, so the rest of the
  path (validation, X-Sample-Rate) is unchanged.

TTS adapter v2: Pithagoras portal Breeze-native JSON -> upstream OpenAI TTS API.

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
# v3: a Voice Studio profile id "clone:<name>". The name after the colon may be
# several space-separated words (profiles are saved under human names like
# "Vivian 17B"), but each word still follows the same whitelist, so the value
# stays safe to embed in the upstream JSON request verbatim.
CLONE_ID_RE = re.compile(r"clone:[a-zA-Z0-9_-]{1,32}(?: [a-zA-Z0-9_-]{1,32})*")

# v3: the clone engine (1.7B-Base, CPU) that "clone:" voices are routed to.
# Separate from the primary upstream (presets/Kokoro) so the two models never
# have to share a process. Empty = clone routing disabled (behaviour = v2).
CLONE_UPSTREAM = os.environ.get("QWEN_BASE_UPSTREAM", "").rstrip("/")
# v3: the portal's static voice-list file (baked into the image at
# /app/web/dist/avatar/kokoro-voices.js; on the host it is bind-mounted over
# that path and owned by Voice Studio). When set, saving/deleting a clone
# profile rewrites the file so the avatar page's picker lists "Cloned"
# voices. Unset = this adapter never touches any file.
VOICES_FILE = os.environ.get("QWEN_VOICES_FILE", "")

# v3: the avatar page's voice picker is built from a STATIC file shipped in
# the image (no fetch, no auth). When a clone profile is saved or deleted,
# regenerate that file (9 presets + a "Cloned" group) so the avatar page's
# list stays in sync. Pure-stdlib, best-effort: a failure here must never
# break the speech request path.
# Note: profile names are already whitelist-validated by CLONE_ID_RE
# ([a-zA-Z0-9_-]+, space-separated) before they reach here, so embedding one
# in the JS string needs no escaping.
def regenerate_voices_file(clones):
    """Rewrite VOICES_FILE with the 9 preset speakers + one 'Cloned' group."""
    if not VOICES_FILE:
        return False
    try:
        presets = [
            ("vivian",   "F", "Vivian · young female · bright, slightly edgy (default)"),
            ("serena",   "F", "Serena · young female · warm, gentle"),
            ("ono_anna", "F", "Ono Anna · Japanese female · playful, light, nimble"),
            ("sohee",    "F", "Sohee · Korean female · warm, rich emotion"),
            ("ryan",     "M", "Ryan · male · dynamic, strong rhythmic drive"),
            ("aiden",    "M", "Aiden · American male · sunny, clear midrange"),
            ("dylan",    "M", "Dylan · Beijing male · clear, natural"),
            ("eric",     "M", "Eric · Chengdu male · lively, slightly husky"),
            ("uncle_fu", "M", "Uncle Fu · seasoned male · low, mellow timbre"),
        ]
        lines = [
            "// TTS engine voices available on the local TTS backend.",
            "// AUTO-GENERATED by the TTS adapter Voice Studio - do not edit by hand.",
            "// 9 preset speakers (Qwen3-TTS 1.7B-CustomVoice, GPU) plus cloned",
            "// voices (1.7B-Base voice library, CPU clone engine).",
            'window.KOKORO_DEFAULT_VOICE = "vivian";',
            "window.KOKORO_VOICES = [",
        ]
        for vid, grp, label in presets:
            lines.append(f'  {{ id: "{vid}", g: "{grp}", t: "{label}" }},')
        for c in sorted(clones):
            name = (c or "").split(":", 1)[1].strip()
            lines.append(f'  {{ id: "clone:{name}", g: "C", t: "{name} · cloned voice" }},')
        lines.append("];")
        lines.append("window.KOKORO_LABELS = Object.fromEntries(window.KOKORO_VOICES.map(v => [v.id, v.t]));")
        tmp = VOICES_FILE + ".tmp"
        with open(tmp, "w") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, VOICES_FILE)
        print(f"  -> voices file regenerated: {len(clones)} clone(s) -> {VOICES_FILE}", flush=True)
        return True
    except Exception as e:
        print(f"  -> voices-file regen FAILED (non-fatal): {e!r}", flush=True)
        return False


def call_upstream(text, voice="", target=None):
    """Non-streaming POST to an upstream TTS (Kokoro, Qwen3-TTS, or the Base
    clone engine) over a raw socket. -> (status, headers, body).

    voice: an optional per-request voice id (Kokoro id, Qwen speaker, or
    "clone:<profile>" for the clone engine); empty falls back to the VOICE env
    default. The upstream "model" and the voice value are engine-adjusted: the
    Qwen router wants model "tts-1" and its preset speaker names, Kokoro wants
    "kokoro" and its own ids. The raw-socket body is otherwise identical (same
    PCM contract).

    target: (host, port) to send the request to. Defaults to the primary
    upstream; the clone engine passes its own (CLONE_UPSTREAM) and the voice
    id is passed through verbatim (map_voice must not be applied to clones —
    it would rewrite them into preset names)."""
    if target is None:
        host, port = U_HOST, U_PORT
    else:
        host, port = target
    if target is not None and voice and voice.lower().startswith("clone:"):
        eff_voice = voice          # pass clone ids through verbatim
    else:
        eff_voice = map_voice(voice or VOICE)
    model = "tts-1" if ENGINE == "qwen3" else "kokoro"
    body = json.dumps({"model": model, "input": text, "voice": eff_voice,
                       "response_format": "pcm", "stream": False}).encode()
    req = (b"POST /v1/audio/speech HTTP/1.1\r\n"
           b"Host: " + host.encode() + b":" + str(port).encode() + b"\r\n"
           b"Content-Type: application/json\r\n"
           b"Authorization: Bearer " + KEY.encode() + b"\r\n"
           b"Content-Length: " + str(len(body)).encode() + b"\r\n"
           b"Connection: close\r\n\r\n" + body)
    s = socket.create_connection((host, port), timeout=180)
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
            self._send(200, json.dumps({"status": "ok", "engine": "tts-adapter-v3",
                                       "upstream": UPSTREAM, "tts_engine": ENGINE,
                                       "voice": VOICE, "voice_map": VOICE_MAP,
                                       "qwen_native": sorted(QWEN_NATIVE),
                                       "qwen_reverse": QWEN_REVERSE,
                                       "clone_upstream": CLONE_UPSTREAM,
                                       "voices_file": VOICES_FILE}).encode())
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
            # v3: "clone:<name>" targets the separate Base clone engine.
            clone_target = None
            if voice.lower().startswith("clone:"):
                if not CLONE_ID_RE.fullmatch(voice):
                    print(f"POST /v1/audio/speech voice={voice!r} REJECTED (malformed clone id)", flush=True)
                    self._send(400, json.dumps({"error": "clone id must look like 'clone:My Voice Name'"}).encode())
                    return
                if not CLONE_UPSTREAM:
                    print(f"POST /v1/audio/speech voice={voice!r} REJECTED (clone engine not configured)", flush=True)
                    self._send(400, json.dumps({"error": "voice cloning is not available on this server"}).encode())
                    return
                clone_target = CLONE_UPSTREAM.split("//")[1].rsplit(":", 1)
            elif voice and not VOICE_ID_RE.fullmatch(voice):
                print(f"POST /v1/audio/speech voice={voice!r} REJECTED (not a voice id)", flush=True)
                self._send(400, json.dumps({"error": "voice must be a Kokoro voice id like af_heart"}).encode())
                return
            print(f"POST /v1/audio/speech in={len(text)} chars voice={voice or VOICE}"
                  + (f" ->[clone]{CLONE_UPSTREAM}" if clone_target else
                     (f" ->{map_voice(voice or VOICE)}" if ENGINE == "qwen3" else "")), flush=True)
            if not text:
                self._send(400, b'{"error":"no text"}')
                return
            status, headers, audio = call_upstream(text, voice, target=clone_target)
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
    print(f"adapter v3 listening on {BIND}:{PORT} -> {UPSTREAM}"
          + (f" (+clone {CLONE_UPSTREAM})" if CLONE_UPSTREAM else "")
          + f" (voice={VOICE}, non-streaming)", flush=True)
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
