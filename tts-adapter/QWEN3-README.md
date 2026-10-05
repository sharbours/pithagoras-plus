# Qwen3-TTS 1.7B PoC (build #61, experimental — `exp/qwen3-tts` branch)

Drop-in TTS engine replacement for Kokoro on the .210 avatar stack.
Status: **LIVE (cut over 2026-10-05, Gate C done)** — Qwen3-TTS is the active
TTS with **Vivian** the default voice; Kokoro is stopped (not removed) and a
plain reboot restores it. Production code2 (`main`) is untouched and reboot-able.

## Why it fits (measured on the RTX 3060 12 GB)

| state | llama-server | TTS | total |
|---|---|---|---|
| production (Kokoro) | 6808 MiB (`-c 49152`) | 5008 MiB | **11865 / 12288** |
| **after cutover (Qwen3-TTS, LIVE)** | **5012 MiB** (`-c 8192`) | **4338 MiB** (1.7B bf16, sdpa) | **~9350 / 12288** (~2.9 GB headroom) |

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
  qwen3-cutover.sh  qwen3-restore-code2.sh  qwen3-rollback.sh   # switch scripts
  gateA.log  cutover.log  restore.log       # logs
/etc/systemd/system/qwen3-tts.service       # User=hermes, cwd=/opt/qwen3-tts; SELF-
                                            # SUFFICIENT — [Service] carries all the
                                            # Environment= lines below. DISABLED: a
                                            # reboot never auto-starts Qwen3.
/etc/systemd/system/qwen3-reboot-restore.service  # ENABLED oneshot: runs
                                            # qwen3-restore-code2.sh at every boot so a
                                            # plain reboot ALWAYS lands on code2/Kokoro
                                            # (Kokoro+adapter are docker-run
                                            # unless-stopped, so they self-start; this
                                            # undoes any live Qwen3 cutover + resets
                                            # llama to -c 49152).
/var/log/qwen3-tts.log
```

Env the service needs (all read by the code, not the yaml) — these live in the
unit's `[Service]` section (it is self-sufficient; no launcher needed):
`PORT=7866 HOST=127.0.0.1 TTS_BACKEND=official
TTS_MODEL_ID=/opt/qwen3-tts/models/Qwen3-TTS-12Hz-1.7B-CustomVoice
TTS_DEVICE=cuda:0 TTS_DTYPE=bfloat16 TTS_ATTN=sdpa
TTS_WARMUP_ON_START=false ENABLE_VOICE_STUDIO=false
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`

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

## Cutover / rollback / reboot (run on the .210 host)

```bash
# Qwen3-TTS on (Kokoro stopped, llama -c 8192, adapter re-pointed to :7866):
sudo bash /opt/qwen3-tts/qwen3-cutover.sh

# back to code2/Kokoro, one command, no reboot:
sudo bash /opt/qwen3-tts/qwen3-rollback.sh      # == qwen3-restore-code2.sh

# full machine reboot:
#   lands on code2/Kokoro automatically — the ENABLED qwen3-reboot-restore
#   service runs the restore at every boot (idempotent no-op when already on
#   Kokoro). Qwen3-TTS's own unit stays DISABLED, so a reboot never auto-starts it.
```

The scripts recreate the adapter with `docker run` because **Docker 29 removed
`docker update -e`** (env can no longer be edited in place). The adapter was
always a plain `docker run` (not compose), so this is its native form.

All three scripts verify with a real synthesis through the production adapter
(:7864) and print the resulting VRAM; the cutover also hard-fails if
:7866 isn't actually serving (guards the silent "wrong port" misconfig).

## Gate results (2026-10-05)

- **Gate A** (model): loads on cuda:0 (sdpa), 4194 MiB, `/v1/voices` = 9
  speakers, 24 kHz s16le PCM, non-silent. Cold 14.1 s, warm 8.9 s per ~7 s.
- **Gate B** (adapter): `af_heart → vivian` through the new adapter on a test
  port, 200, 7.88 s of PCM.
- **Gate C (LIVE, done):** real cutover through the production adapter —
  `af_heart → vivian` 200 (9.98 s incl. first warm), VRAM 9319. Then a full
  round-trip test: boot-restore → Kokoro speaks (0.65 s), cutover again →
  Qwen3/Vivian speaks (6.9 s warm). Final live state: **Qwen3 on, Vivian
  default, Kokoro stopped, qwen3-reboot-restore enabled, qwen3-tts disabled**.
- Samples (24 kHz, pre-cutover): `q3samples/{vivian,serena,sohee,dylan}.mp3`
  on hermes-08-2026.

## Known limits / follow-ups (future sessions)

- Voice cloning = the **Base** 1.7B model (separate 4.5 GB download); the
  CustomVoice model used here does not clone. Emotion control = the router's
  `instruct` field (not yet wired through the adapter/portal).
- Portal has ~45 Kokoro voice options; with 9 Qwen speakers several map to
  the same voice — the picker could be trimmed in a follow-up.
- torch.compile adds ~15–20 s to the first request after each start; set
  `TTS_WARMUP_ON_START=true` if that first-request hitch matters.
- If VRAM ever gets tighter: `-c 4096` on llama, or the 0.6B CustomVoice.
