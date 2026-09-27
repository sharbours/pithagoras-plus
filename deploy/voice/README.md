# Voice stack — as-built on `.210`

The `.210` Pithagoras portal (host-net container `pithagoras`, TLS `:443`) speaks with three
voice services, all loopback on that box. This is the **as-built** record of what is actually
running (verified 2026-09-27), not the upstream generic docs in `docs/guide/`. The companion
**remote-browser** as-built doc is [`deploy/remote-browser/README.md`](../remote-browser/README.md).

```
        ┌─ STT  pithagoras-voice  (shares the portal's network)
portal ─┤   whisper-server  :8188   ggml-base (142 MB), CPU, --language auto
        └─ TTS  pithagoras-tts-adapter  :7864  (python:3.12-slim, host net)
                 └─► pithagoras-kokoro  :7863  (hwdsl2/kokoro-server:cuda, bridge,
                     127.0.0.1:7863 ← 8880)  Kokoro-82M, CUDA, NO auth
```

## TTS: Kokoro-82M + the adapter

The portal's TTS client speaks the **Breeze** request shape (`POST /v1/audio/speech` with
`{model,input,stream,stream_format,response_format,options}`, `runtime:"audio-cpp"`). Kokoro
speaks the **OpenAI** shape. The tiny **adapter** translates between them and streams
24 kHz s16le PCM back.

- **`pithagoras-tts-adapter`** — `python:3.12-slim`, `--network host`,
  `python /app/adapter.py`. Env: `BIND=127.0.0.1`, `PORT=7864`,
  `KOKORO_UPSTREAM=http://127.0.0.1:7863`, **`KOKORO_VOICE=af_heart`** (the live voice).
  It sends *no* Authorization header (Kokoro here runs no-auth). It requests **non-streaming**
  PCM from Kokoro over a **raw socket** (urllib/http.client mis-send the `Authorization` header
  in this build) and returns one clean `audio/pcm` body tagged `X-Sample-Rate: 24000`. Source:
  **`tts-adapter/adapter.py` in this repo** (verified byte-identical to the running copy at
  `/opt/pithagoras/tts-adapter/adapter.py` on `.210`).
- **`pithagoras-kokoro`** — `hwdsl2/kokoro-server:cuda`, `--gpus all`, **bridge** network with
  `127.0.0.1:7863:8880`, volume `kokoro-data:/var/lib/kokoro`, `KOKORO_DEVICE=cuda`,
  `--restart unless-stopped`, **no auth**. The image's first start generates an API key, but on
  `.210` auth was deliberately disabled (loopback-only, so auth adds nothing): the volume's
  `.api_key` was cleared and `.auth_enabled` set to `0`. A bare `curl /v1/models` → 200
  confirms it.
- **Model:** `Kokoro-82M` (hexgrad), auto-fetched by the server into the `kokoro-data` volume
  (`/var/lib/kokoro/hub/…`, ~315 MB). 54 voices; the active one is set in the adapter's
  `KOKORO_VOICE` env, **not** in the portal's voice config (its `voice` value only applies to the
  Breeze path).

## STT: Whisper ggml-base

- **`pithagoras-voice`** — `nvidia/cuda:12.4.1-devel-ubuntu22.04`, created by the **portal's own
  voice extension** (it owns this container), with **`--network container:<pithagoras-id>`** so it
  shares the portal's network namespace (both on host net → `127.0.0.1` inside it is the host's).
  GPU requested (1 device) though Whisper here is CPU. Volume `pithagoras_voice-models:/voice`.
- Runs **`whisper-server`** (the container's bundled build, `/voice/whisper/build/bin/`) on
  **`127.0.0.1:8188`**, `--model /voice/models/ggml-base.bin --language auto --threads 4`, plus
  the bundled `audiocpp_server` (Breeze) as the **rollback TTS** (its 4.6 GB model stays
  lazy/unloaded — do not load it alongside the 8 B LLM; no VRAM headroom).
- **`ggml-base.bin`** = 142 MB; the models volume is 4.8 GB (it also holds the Breeze model).

## Wiring (the portal side)

The portal's voice config lives in its **SQLite `settings` table, key `voice`** (in the
`pithagoras_portal-data` volume, `/data/portal.db`) — **not** in `.env`. On `.210` it is:

```json
{"enabled": true, "runtime": "audio-cpp",
 "breezeUrl": "http://127.0.0.1:7864/v1/audio/speech",
 "whisperUrl": "http://127.0.0.1:8188/inference",
 "voice": "design", "language": "en", "cfgScale": 4, "lazyLoad": true,
 "vad": {"positiveSpeechThreshold":0.65, "negativeSpeechThreshold":0.35,
         "minSpeechMs":256, "preSpeechPadMs":320, "redemptionMs":1000},
 "instruction": "A warm, clear English voice with a calm, conversational delivery."}
```

`breezeUrl` points at the **adapter** (port 7864), which is what routes speech to Kokoro — the
name is legacy. Because the config is in SQLite (not env), a **`docker compose restart` will not
change it**; recreate the portal for env-level changes, or edit the row / `PUT /api/voice`.
VAD (Silero v5) runs **client-side in the browser**; the mic + echo-loop and double-TTS fixes
from the 2026-09-19 work are all in the web build (see the skill's voice sections).

## Rebuilding from scratch (the recreate recipes)

```sh
# Kokoro (no-auth): volume must have .api_key removed and .auth_enabled=0
docker rm -f pithagoras-kokoro
docker volume rm kokoro-data        # fresh — refetches Kokoro-82M on first start
docker run -d --name pithagoras-kokoro --gpus all \
  -p 127.0.0.1:7863:8880 \
  -v kokoro-data:/var/lib/kokoro \
  -e KOKORO_DEVICE=cuda --restart unless-stopped \
  hwdsl2/kokoro-server:cuda
# then in the volume:  rm .api_key .auto_api_key_created; printf 0 > .auth_enabled

# Adapter (source from this repo)
docker rm -f pithagoras-tts-adapter
docker run -d --name pithagoras-tts-adapter --network host --restart unless-stopped \
  -e BIND=127.0.0.1 -e PORT=7864 \
  -e KOKORO_UPSTREAM=http://127.0.0.1:7863 -e KOKORO_VOICE=af_heart \
  -v /opt/pithagoras/tts-adapter/adapter.py:/app/adapter.py:ro \
  python:3.12-slim python /app/adapter.py

# Voice (STT) — created BY the portal's voice extension; manual recreate if ever needed:
docker rm -f pithagoras-voice
docker create --name pithagoras-voice \
  --network container:$(docker inspect pithagoras --format '{{.Id}}') \
  --gpus all \
  --label pithagoras.addon=voice --label pithagoras.voice-network=shared-v1 \
  --restart=no -t \
  -v pithagoras_voice-models:/voice \
  nvidia/cuda:12.4.1-devel-ubuntu22.04 bash -c "<contents of deploy/voice/setup.sh>"
docker start pithagoras-voice
```

`deploy/voice/setup.sh` (next to this file) is the self-healing install the extension embeds: if
the built `whisper-server` + `audiocpp_server` binaries and both model files already exist it
skips apt/build/download entirely and just starts the services (no network, cannot fail); on a
truly fresh build it first fixes the rotated Ubuntu keyring before `apt-get update`.

## Footprint & gotchas (the ones that cost time)

- **GPU (RTX 3060 12 GB):** Qwen3-8B LLM ~7.2 GB + Kokoro ~0.8 GB ≈ **9.4 / 12.3 GB** resident.
  Whisper base is CPU (`--threads 4`). Breeze's 4.6 GB model must **not** load alongside the 8 B.
- **`docker compose restart` does not re-read `.env`** and the voice config is in SQLite anyway —
  use recreate for env changes; the extension re-attaches the existing voice container on
  recreate (it only recreates it if the portal's container **id** changed).
- **Whisper STT regression class:** a *fresh* `pithagoras-voice` run of the old setup.sh died in
  `apt-get update` on GPG invalid-signature (rotated Ubuntu 2020+ keyring vs the 2018-era key in
  the CUDA base image) → STT never started even though the binaries persisted. The current
  setup.sh self-heals (see above) so a recreate never breaks STT again.
- **The two TTS clients** (`VoiceControl` in voice mode and `SpeakReplies` for read-aloud) both
  POST to the same endpoint with a `source` tag; if you hear a reply spoken twice ~200 ms apart,
  grep the portal log for `[voice/speech]` — two lines with the same text = the double-TTS bug
  (fixed 2026-09-19, in the web build).
- **Kokoro key quirk (if you re-enable auth):** this build's urllib client mis-sends the
  `Authorization` header (401 even with the correct key) while curl works — another reason the
  adapter uses a raw socket and the box runs no-auth.
