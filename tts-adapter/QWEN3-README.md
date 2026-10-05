# Qwen3-TTS 1.7B PoC (build #61, experimental — `exp/qwen3-tts` branch)

Drop-in TTS engine replacement for Kokoro on the .210 avatar stack.
Status: **proof of concept verified 2026-10-05** (Gates A+B). Cutover/rollback
scripts below; production (code2, `main`) is untouched and reboots to itself.

## Why it fits (measured on the RTX 3060 12 GB)

| state | llama-server | TTS | total |
|---|---|---|---|
| production (Kokoro) | 6808 MiB (`-c 49152`) | 5008 MiB | **11865 / 12288** |
| after cutover (Qwen3-TTS) | ~4600 MiB (`-c 8192`) | **4194 MiB** (1.7B bf16, sdpa) | **~8800** |

- Qwen3-TTS 12 Hz 1.7B **CustomVoice**: 9 preset speakers (vivian, serena,
  sohee, ono_anna, dylan, ryan, eric, aiden, uncle_fu), 24 kHz output,
  OpenAI-compatible `/v1/audio/speech` returning 16-bit LE PCM — the exact
  contract the adapter/portal already speak.
- The backend loads via `from_pretrained(local_dir, device_map=cuda:0,
  bfloat16)`; it needs the `speech_tokenizer/` subfolder inside the model dir
  (the CustomVoice repo bundles it → single 4.5 GB download, `hf download`).
- `torch.compile(reduce-overhead)` + TF32 are applied automatically; warm
  synthesis ≈ 1.2× real-time (8.9 s for 7.2 s of speech; first request after
  load ≈ 14 s).
- **Gotcha:** the official backend ignores `TTS_DEVICE` and auto-falls back to
  CPU (31 s / 6 s of speech) if the GPU load OOMs. It MUST have the ~5 GB
  Kokoro freed first — that is what the cutover does.

## Layout on .210 (host venv + systemd, deliberately NOT a docker image)

```
/opt/qwen3-tts/
  models/Qwen3-TTS-12Hz-1.7B-CustomVoice/   # 4.5 GB, incl. speech_tokenizer/
  venv/                                     # py3.10: torch cu121, transformers 4.57.3,
                                            # qwen_tts (groxaxo/Qwen3-TTS-Openai-Fastapi),
                                            # fastapi/uvicorn, onnxruntime (25hz VQ dep)
  api/  gradio_voice_studio.py  qwen_tts/   # copied from venv site-packages;
                                            # api/main.py patched: gradio import guarded
  config.yaml                               # (informational; main.py reads env, not yaml)
  adapter.py                                # copy of the code3 tts-adapter/adapter.py
  gateA.log                                 # gate logs
/etc/systemd/system/qwen3-tts.service       # User=hermes, cwd=/opt/qwen3-tts,
                                            # PYTHONPATH=venv/site-packages,
                                            # logs -> /var/log/qwen3-tts.log
                                            # NOT enabled: reboot keeps Kokoro
/var/log/qwen3-tts.log
```

Env the service needs (all read by the code, not the yaml):
`PORT=7866 HOST=127.0.0.1 TTS_BACKEND=official
TTS_MODEL_ID=/opt/qwen3-tts/models/Qwen3-TTS-12Hz-1.7B-CustomVoice
TTS_DEVICE=cuda:0 TTS_DTYPE=bfloat16 TTS_ATTN=sdpa
TTS_WARMUP_ON_START=false ENABLE_VOICE_STUDIO=false
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`

The unit file on .210 was written without these `Environment=` lines (env is
passed by the launcher); if you want the service self-sufficient, add the
lines above to the `[Service]` section and `systemctl daemon-reload`.

## The voice map (the only code change)

`tts-adapter/adapter.py` gained an engine switch. With `TTS_ENGINE=qwen3`
(env) the adapter:
- sends `model: "tts-1"` (Qwen router) instead of `"kokoro"`,
- maps the portal's Kokoro ids → Qwen speakers via `VOICE_MAP` (JSON env):

```json
{"af_heart":"vivian","af_bella":"serena","af_sarah":"sohee","af_aoede":"ono_anna",
 "am_michael":"dylan","am_eric":"eric","am_antony":"ryan","am_charlie":"aiden"}
```
  (unmapped ids → `QWEN_DEFAULT_VOICE`, default `vivian`);
- `/health` now reports `tts_engine` + `voice_map`.

With `TTS_ENGINE=kokoro` (default) the adapter is byte-identical in behavior
to the pre-#61 version, so the same file serves both engines and a Kokoro
deployment that never sets the env is unaffected. The portal needs **zero**
changes.

## Cutover / rollback (run on the .210 host)

```bash
# Qwen3-TTS on (Kokoro stopped, llama -c 8192, adapter re-pointed):
sudo bash /opt/qwen3-tts/qwen3-cutover.sh

# back to code2/Kokoro, one command, no reboot:
sudo bash /opt/qwen3-tts/qwen3-rollback.sh

# full machine reboot:
#   production returns to Kokoro automatically (qwen3-tts not enabled,
#   llama unit only reverted if you ran rollback; if you rebooted right
#   after a cutover, run the rollback script once after boot).
```

(Both scripts also live in this repo under `tts-adapter/`.)

Both scripts verify their work with a real synthesis through the production
adapter (:7864) and print the resulting VRAM.

## Gated acceptance results (2026-10-05)

- **Gate A** (model): loads on cuda:0 (sdpa), 4194 MiB, `/v1/voices` = 9
  speakers, 24 kHz s16le PCM, non-silent. Cold 14.1 s, warm 8.9 s per ~7 s.
- **Gate B** (adapter): `af_heart → vivian` through the new adapter on a test
  port, 200, 7.88 s of PCM.
- **Gate C** (E2E through the live portal): NOT run in this session — it
  changes production state; the cutover script does it, and you should hear
  the samples first (see `q3samples/*.mp3` on hermes-08-2026).
- Samples (24 kHz): vivian/serena/sohee/dylan — the four most likely
  character mappings.

## Known limits / follow-ups (future sessions)

- Voice cloning = the **Base** 1.7B model (separate 4.5 GB download); the
  CustomVoice model used here does not clone. Emotion control = the router's
  `instruct` field (not yet wired through the adapter/portal).
- Portal has ~45 Kokoro voice options; with 9 Qwen speakers several map to
  the same voice — the picker could be trimmed in a follow-up.
- torch.compile adds ~15–20 s to the first request after each start; set
  `TTS_WARMUP_ON_START=true` if that first-request hitch matters.
- If VRAM ever gets tighter: `-c 4096` on llama, or the 0.6B CustomVoice.
