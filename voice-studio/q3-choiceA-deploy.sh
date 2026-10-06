#!/bin/bash
# Choice A DEPLOY (test-first): 1.7B-Base CPU clone engine + Voice Studio +
# adapter v3 -- all on side services; production avatar keeps speaking the
# preset voices until the user approves the final cutover.
# Run on the .210 host. Idempotent-ish; safe to re-run.
set -uo pipefail
D=/opt/qwen3-tts
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }

log "== 1/6 stage files =="
install -m 755 /tmp/qwen3-tts-base.service /etc/systemd/system/qwen3-tts-base.service
install -m 755 /tmp/voice-studio-adapter.service /etc/systemd/system/voice-studio-adapter.service
mkdir -p /opt/qwen3-tts/voice-studio
install -m 644 /tmp/voice-studio-adapter.py /opt/qwen3-tts/voice-studio/adapter.py
# the production voice library (shared Base <-> studio)
mkdir -p /opt/qwen3-tts/voice_library/profiles
chown -R hermes:hermes /opt/qwen3-tts/voice_library
# seed a demo profile from the verified 1.7B test profile (if present)
if [ -d /opt/qwen3-tts/voice_library-test/profiles ] && [ -z "$(ls -A /opt/qwen3-tts/voice_library/profiles 2>/dev/null)" ]; then
  cp -a /opt/qwen3-tts/voice_library-test/profiles/. /opt/qwen3-tts/voice_library/profiles/ 2>/dev/null || true
fi
# the host-side copy of the avatar voice list (studio's write target)
mkdir -p /opt/pithagoras/web/avatar
sudo docker exec pithagoras cat /app/web/dist/avatar/kokoro-voices.js > /opt/pithagoras/web/avatar/kokoro-voices.js
chown hermes:hermes /opt/pithagoras/web/avatar/kokoro-voices.js
log "staged: base unit, studio unit+code, voice_library, voices file ($(stat -c%s /opt/pithagoras/web/avatar/kokoro-voices.js) B)"

log "== 2/6 start qwen3-tts-base (1.7B-Base, CPU, :7869) =="
sudo systemctl daemon-reload
sudo systemctl enable --now qwen3-tts-base
# poll until it serves (model pre-loads at startup: 1-3 min)
for i in $(seq 1 60); do
  if curl -sk -m 3 http://127.0.0.1:7869/v1/voices 2>/dev/null | grep -q voices; then
    break
  fi
  sleep 5
  if ! systemctl is-active -q qwen3-tts-base; then
    echo "FATAL: qwen3-tts-base died; tail /var/log/qwen3-tts-base.log:"; tail -15 /var/log/qwen3-tts-base.log; exit 1
  fi
done
log "base serving after ~$((i*5))s"

log "== 3/6 start voice-studio-adapter (:7871, LAN) =="
sudo systemctl enable --now voice-studio-adapter
sleep 2
systemctl is-active voice-studio-adapter | grep -q active || { tail -15 /var/log/voice-studio-adapter.log; exit 1; }
log "studio up"

log "== 4/6 E2E on the TEST path (not production) =="
# a) capabilities
log "capabilities: $(curl -s -m 5 http://127.0.0.1:7869/v1/audio/voice-clone/capabilities)"
# b) voices list (seeded profile)
log "voices: $(curl -s -m 5 http://127.0.0.1:7869/v1/voices | head -c 200)"
# c) clone synthesis through the BASE directly
T0=$(date +%s)
curl -s -m 300 -o /tmp/vs-a-demo.pcm -w "clone direct: http=%{http_code} bytes=%{size_download} wall=%{time_total}s\n" \
  -H 'Content-Type: application/json' \
  -d '{"model":"tts-1","input":"This is a demo of the production clone engine speaking through the new Voice Studio pipeline.","voice":"clone:Vivian 17B","response_format":"pcm"}' \
  http://127.0.0.1:7869/v1/audio/speech
# d) studio save -> voices-file regen -> in-container push
log "studio save:"
curl -s -m 300 -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"Vivian 17B\",\"ref_audio\":\"$(base64 -w0 /tmp/vs-ref-vivian.wav)\",\"x_vector_only_mode\":true,\"language\":\"auto\"}" \
  http://127.0.0.1:7871/v1/voice/profiles; echo
sleep 1
log "voices file after save (host copy):"; cat /opt/pithagoras/web/avatar/kokoro-voices.js | tail -5
log "voices file in container:"; sudo docker exec pithagoras sh -c "tail -3 /app/web/dist/avatar/kokoro-voices.js"
log "studio health: $(curl -s -m 5 http://127.0.0.1:7871/health | head -c 200)"
# e) studio clone test (named profile)
log "studio named-profile test:"
curl -s -m 300 -X POST -H 'Content-Type: application/json' \
  -d '{"profile":"clone:Vivian 17B","text":"Studio pipeline test: the saved profile works end to end.","response_format":"wav"}' \
  http://127.0.0.1:7871/v1/voice/clone | head -c 200; echo

log "== 5/6 GPU + disk sanity =="
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
df -h / | tail -1
free -g | head -2

log "== 6/6 deploy complete =="
log "TEST PATH LIVE:  http://127.0.0.1:7871/studio  (LAN: http://192.168.0.210:7871/studio)"
log "Production avatar UNTOUCHED (still speaks presets via the v2 adapter)."
log "NEXT: user approves cutover -> run /opt/qwen3-tts/qwen3-cutover.sh (adapter v3 + QWEN_BASE_UPSTREAM on :7864)"
