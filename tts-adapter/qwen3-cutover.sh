#!/bin/bash
# ============================================================================
# Qwen3-TTS 1.7B PoC — CUTOVER (build #61, experimental; run on the .210 host)
#
# Switches the live TTS path from Kokoro (:7863) to Qwen3-TTS (:7866):
#   1. stops pithagoras-kokoro                    (frees ~5 GB VRAM)
#   2. shrinks llama-server ctx 49152 -> 16384    (~0.3 GB q4-KV; keeps the pi 4096-token output reserve workable)
#   3. starts qwen3-tts (systemd; 1.7B lazy-loads on first request)
#   4. starts qwen3-tts-base (the 1.7B-Base voice-clone engine, CPU, :7869)
#   5. swaps the production adapter file (bind-mounted into the adapter
#      container, ro) for the v3 version + sets TTS_ENGINE=qwen3 and
#      QWEN_BASE_UPSTREAM (clone: voices -> :7869, presets -> :7866)
#   6. starts voice-studio-adapter (clone-voice manager UI, :7871, LAN)
#
# The PORTAL is untouched (zero code changes; it only talks to the adapter).
# Rollback:  ./qwen3-rollback.sh   (one command, no reboot needed)
# After a full machine reboot: production returns to code2/Kokoro automatically
# (qwen3-tts is NOT systemctl-enabled; llama unit reverts on rollback).
#
# VRAM (RTX 3060 12 GB, measured 2026-10-05):
#   production:            llama 6808 + kokoro 5008          = 11865 MiB
#   after cutover:         llama(-c16384) ~5344 + qwen3 4482 = ~9826 MiB (2 GB headroom)
#
# Requires: /opt/qwen3-tts ready (venv, models, api code) - see QWEN3-README.md
# ============================================================================
set -uo pipefail
QWEN3_PORT=7866
ADAPTER=pithagoras-tts-adapter
LLAMA=llama-server
NEW_CTX=16384  # 8192 broke the pi voice-brain clamp (ctx+4096 reserve > window -> max_tokens=1); 16384 costs ~320 MiB q4-KV only
AD_FILE=/opt/pithagoras/tts-adapter/adapter.py
AD_BAK=/opt/pithagoras/tts-adapter/adapter.py.q3-bak
NEW_ADAPTER=${NEW_ADAPTER:-/opt/qwen3-tts/adapter.py}
BASE_PORT=7869
STUDIO_PORT=7871
VOICE_MAP='{"af_heart":"vivian","af_bella":"serena","af_sarah":"sohee","af_aoede":"ono_anna","am_michael":"dylan","am_eric":"eric","am_antony":"ryan","am_charlie":"aiden"}'

echo "== 1/6 stop kokoro =="
docker stop pithagoras-kokoro

echo "== 2/6 llama-server ctx -> $NEW_CTX =="
sudo cp /etc/systemd/system/$LLAMA.service /etc/systemd/system/$LLAMA.service.bak-c49152
sudo sed -i "s/-c [0-9]*/-c $NEW_CTX/" /etc/systemd/system/$LLAMA.service
sudo systemctl daemon-reload
sudo systemctl restart $LLAMA
sleep 8
ss -ltn | grep -q :8080 || { echo "llama-server not listening on :8080 - ABORT"; exit 1; }

echo "== 3/6 start qwen3-tts (presets, GPU) =="
sudo systemctl start qwen3-tts
sleep 3
systemctl is-active qwen3-tts | grep -q active || { echo "qwen3-tts failed - check /var/log/qwen3-tts.log"; exit 1; }
echo "   (model lazy-loads on first synthesis; VRAM rises then)"
echo "== 4/6 start qwen3-tts-base (clone engine, CPU, :$BASE_PORT) =="
sudo systemctl start qwen3-tts-base
# base pre-loads the 1.7B model at startup; poll until it serves
for i in $(seq 1 60); do
  if curl -sk -m 3 http://127.0.0.1:$BASE_PORT/v1/voices 2>/dev/null | grep -q 'vivian\|voices'; then
    break
  fi
  sleep 5
  if ! systemctl is-active -q qwen3-tts-base; then
    echo "qwen3-tts-base failed - check /var/log/qwen3-tts-base.log"; exit 1
  fi
done
echo "   clone engine serving on :$BASE_PORT (model pre-loaded, CPU)"

echo "== 5/6 swap adapter file (v3) + recreate adapter container with qwen3 env =="
# NOTE: Docker 29 dropped `docker update -e`; env can only be changed by
# re-running the container. The original was a docker-run (bind-mounted
# adapter.py, host network) — recreate it with the same spec + qwen3 env.
if [ ! -f "$NEW_ADAPTER" ]; then
  echo "missing $NEW_ADAPTER (run the Qwen3 setup first - QWEN3-README.md)"; exit 1
fi
[ -f "$AD_BAK" ] || cp -p "$AD_FILE" "$AD_BAK"
cp "$NEW_ADAPTER" "$AD_FILE"
docker rm -f $ADAPTER >/dev/null 2>&1
docker run -d --name $ADAPTER --network host --restart unless-stopped \
  -e KOKORO_VOICE=af_heart \
  -e BIND=127.0.0.1 \
  -e PORT=7864 \
  -e KOKORO_UPSTREAM=http://127.0.0.1:$QWEN3_PORT \
  -e TTS_ENGINE=qwen3 \
  -e VOICE_MAP="$VOICE_MAP" \
  -e QWEN_DEFAULT_VOICE=vivian \
  -e QWEN_BASE_UPSTREAM=http://127.0.0.1:$BASE_PORT \
  -v $AD_FILE:/app/adapter.py:ro \
  python:3.12-slim python /app/adapter.py >/dev/null
sleep 3
echo "   adapter health:"
curl -sk -m 10 http://127.0.0.1:7864/health; echo

echo
echo "== VERIFY: qwen3-tts actually listening (guard against silent misconfig) =="
if ! curl -sk -m 10 http://127.0.0.1:$QWEN3_PORT/v1/voices | grep -q vivian; then
  echo "FATAL: qwen3-tts not serving on :$QWEN3_PORT (check 'systemctl status qwen3-tts' + log)"; exit 1
fi
echo "   qwen3-tts serving on :$QWEN3_PORT"
echo "== VERIFY: warm the model via the PROD adapter (:7864, voice af_heart->vivian) =="
curl -sk -m 300 -o /tmp/cutover-warmup.pcm -w 'warmup http=%{http_code} bytes=%{size_download} wall=%{time_total}s\n' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Cutover complete. The avatar is now speaking with the Qwen engine.","voice":"af_heart"}' \
  http://127.0.0.1:7864/v1/audio/speech
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader

echo "== 6/6 start voice-studio-adapter (clone manager, :$STUDIO_PORT, LAN) =="
sudo systemctl start voice-studio-adapter
sleep 2
systemctl is-active voice-studio-adapter | grep -q active || echo "   (studio adapter not up - check /var/log/voice-studio-adapter.log)"
curl -sk -m 5 http://127.0.0.1:$STUDIO_PORT/health | head -c 300; echo
echo
echo "CUTOVER DONE. Clone voices: http://<host>:$STUDIO_PORT/studio (LAN); presets via the avatar as before."
echo "Rollback: ./qwen3-rollback.sh  (or reboot for full code2 state)"
