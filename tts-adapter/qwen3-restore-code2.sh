#!/bin/bash
# ============================================================================
# Qwen3-TTS PoC — RESTORE CODE2 (idempotent). The authoritative "back to
# production" action, and what the enabled qwen3-reboot-restore service runs
# at boot so a plain reboot ALWAYS lands on the code2/Kokoro stack.
#
# Safe to run any number of times; when the box is already on Kokoro it is a
# cheap no-op (it skips the llama restart when the context is already 49152).
# ============================================================================
set -uo pipefail
QLOG=/opt/qwen3-tts/restore.log
LLAMA=llama-server
ADAPTER=pithagoras-tts-adapter
AD_FILE=/opt/pithagoras/tts-adapter/adapter.py
AD_BAK=/opt/pithagoras/tts-adapter/adapter.py.q3-bak
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }

# --- llama context back to code2's 49152 (only if it was shrunk) ---
CUR=$(grep -oE '\-c [0-9]+' /etc/systemd/system/$LLAMA.service 2>/dev/null | grep -oE '[0-9]+' | head -1)
if [ "${CUR:-49152}" != "49152" ]; then
  log "llama ctx $CUR -> 49152 (restoring code2)"
  if [ -f /etc/systemd/system/$LLAMA.service.bak-c49152 ]; then
    sudo cp /etc/systemd/system/$LLAMA.service.bak-c49152 /etc/systemd/system/$LLAMA.service
  else
    sudo sed -i "s/-c [0-9]*/-c 49152/" /etc/systemd/system/$LLAMA.service
  fi
  sudo systemctl daemon-reload
  sudo systemctl restart $LLAMA
else
  log "llama already at 49152 (skip restart)"
fi

# --- stop the Qwen3-TTS service (releases its ~4.3 GB) ---
sudo systemctl stop qwen3-tts 2>/dev/null && log "qwen3-tts stopped" || log "qwen3-tts not running (ok)"

# --- Kokoro container up ---
if docker ps --format '{{.Names}}' | grep -qx pithagoras-kokoro; then
  log "kokoro already up"
else
  docker start pithagoras-kokoro >/dev/null 2>&1 && log "kokoro started" || log "kokoro start FAILED"
fi

# --- re-point the (single) adapter to Kokoro, auto-start on future boots ---
if [ -f "$AD_BAK" ]; then cp -p "$AD_BAK" "$AD_FILE"; fi
docker rm -f $ADAPTER >/dev/null 2>&1
docker run -d --name $ADAPTER --network host --restart unless-stopped \
  -e KOKORO_VOICE=af_heart \
  -e BIND=127.0.0.1 \
  -e PORT=7864 \
  -e KOKORO_UPSTREAM=http://127.0.0.1:7863 \
  -v $AD_FILE:/app/adapter.py:ro \
  python:3.12-slim python /app/adapter.py >/dev/null
log "adapter re-pointed to kokoro (:7863)"
sleep 3

# --- verify (poll: kokoro model + adapter both need a moment after (re)start) ---
for i in $(seq 1 15); do
  H=$(curl -sk -m 5 http://127.0.0.1:7864/health 2>/dev/null)
  if echo "$H" | grep -q '"tts_engine": *"kokoro"'; then
    S=$(curl -sk -m 60 -o /tmp/restore-verify.pcm -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      -d '{"text":"Boot restore check.","voice":"af_heart"}' \
      http://127.0.0.1:7864/v1/audio/speech 2>/dev/null)
    if [ "$S" = "200" ]; then
      log "OK: code2 TTS stack restored and speaking (kokoro, ctx 49152)"
      break
    fi
  fi
  sleep 4
done
[ -s /tmp/restore-verify.pcm ] && echo "restore-verify pcm bytes: $(stat -c%s /tmp/restore-verify.pcm)"

# --- final state ---
echo "=== VRAM ===" ; nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
echo "=== compute apps ===" ; nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
echo "=== containers ===" ; docker ps --format '{{.Names}}\t{{.Status}}'
log "restore finished"
