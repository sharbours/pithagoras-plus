#!/bin/bash
# ============================================================================
# Qwen3-TTS 1.7B PoC — ROLLBACK (run on the .210 host). One command, no reboot.
#
# Restores the exact pre-cutover production state:
#   1. re-points the production adapter at Kokoro (:7863) and restores the
#      original adapter file (adapter.py.q3-bak)
#   2. stops qwen3-tts (frees the ~4.2 GB the 1.7B holds)
#   3. restores llama-server ctx 8192 -> 49152
#   4. starts pithagoras-kokoro
#
# Note: Kokoro's weights live in its docker volume; the container is
# stopped-not-removed, so this is always available.
# ============================================================================
set -uo pipefail
ADAPTER=pithagoras-tts-adapter
LLAMA=llama-server
AD_FILE=/opt/pithagoras/tts-adapter/adapter.py
AD_BAK=/opt/pithagoras/tts-adapter/adapter.py.q3-bak

echo "== 1/4 adapter back to kokoro (restore file + original env) =="
[ -f "$AD_BAK" ] && cp -p "$AD_BAK" "$AD_FILE"
# docker update can only *set* env; the pre-cutover values (captured 2026-10-05)
# are KOKORO_UPSTREAM=:7863, KOKORO_VOICE=af_heart; TTS_ENGINE/VOICE_MAP/
# QWEN_DEFAULT_VOICE were never set on the original container, so set them to
# empty — the adapter treats empty as unset (kokoro default, identity map).
docker update \
  -e TTS_ENGINE= \
  -e KOKORO_UPSTREAM=http://127.0.0.1:7863 \
  -e KOKORO_VOICE=af_heart \
  -e VOICE_MAP= \
  -e QWEN_DEFAULT_VOICE= \
  $ADAPTER >/dev/null
docker restart $ADAPTER >/dev/null
sleep 3
echo "   adapter health:"
curl -sk -m 10 http://127.0.0.1:7864/health; echo

echo "== 2/4 stop qwen3-tts (frees ~4.2 GB VRAM) =="
sudo systemctl stop qwen3-tts

echo "== 3/4 llama-server ctx -> 49152 =="
if [ -f /etc/systemd/system/$LLAMA.service.bak-c49152 ]; then
  sudo cp /etc/systemd/system/$LLAMA.service.bak-c49152 /etc/systemd/system/$LLAMA.service
else
  sudo sed -i "s/-c [0-9]*/-c 49152/" /etc/systemd/system/$LLAMA.service
fi
sudo systemctl daemon-reload
sudo systemctl restart $LLAMA
sleep 8
ss -ltn | grep -q :8080 || { echo "llama-server not up - check journal"; exit 1; }

echo "== 4/4 start kokoro =="
docker start pithagoras-kokoro
sleep 12

echo
echo "== VERIFY: TTS through the prod adapter (expect kokoro, http=200) =="
curl -sk -m 200 -o /tmp/rollback-warmup.pcm -w 'warmup http=%{http_code} bytes=%{size_download} wall=%{time_total}s\n' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Rolled back. Back to the Kokoro voice.","voice":"af_heart"}' \
  http://127.0.0.1:7864/v1/audio/speech
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
docker ps --format '{{.Names}}\t{{.Status}}'
echo
echo "ROLLBACK DONE - production is back to the code2 state."
