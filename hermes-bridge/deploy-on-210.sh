#!/bin/bash
# deploy-on-210.sh — run on 192.168.0.210 (as hermes, sudo where needed).
# Completes the Pithagoras <-> Hermes Agent toggle:
#   1) installs + starts the hermes-bridge systemd service (loopback :7865)
#   2) adds the bridge server to pi's settings.json (with backup)
#   3) verifies end-to-end through the LAN path
# Usage:  sudo bash deploy-on-210.sh
# The bridge.py source + API key are read from the staging tarball if present at
# /tmp/hermes-bridge.tar (pushed by the .197 agent), otherwise from /opt/pithagoras/hermes-bridge/.
set -e

BRIDGE_DIR=/opt/pithagoras/hermes-bridge
KEY_FILE=$BRIDGE_DIR/.key

echo "=== 0. stage files ==="
if [ -f /tmp/hermes-bridge.tar ]; then
  sudo mkdir -p $BRIDGE_DIR
  sudo tar -xf /tmp/hermes-bridge.tar -C /
  sudo rm -f /deploy-on-210.sh
  sudo cp /tmp/deploy-on-210.sh /opt/pithagoras/hermes-bridge/deploy-on-210.sh 2>/dev/null || true
  sudo chown -R hermes:hermes $BRIDGE_DIR
  sudo chmod 700 $BRIDGE_DIR
  sudo chmod 600 $KEY_FILE
  echo "staged from /tmp/hermes-bridge.tar"
else
  [ -f $BRIDGE_DIR/bridge.py ] || { echo "ERROR: need /tmp/hermes-bridge.tar or $BRIDGE_DIR/bridge.py"; exit 1; }
  [ -f $KEY_FILE ] || { echo "ERROR: need $KEY_FILE (64-char Hermes API key, 0600)"; exit 1; }
fi
python3 -m py_compile $BRIDGE_DIR/bridge.py && echo "bridge.py syntax OK"
PYTHON3=$(command -v python3)
[ -n "$PYTHON3" ] || { echo "ERROR: python3 not found on host"; exit 1; }
echo "using python3: $PYTHON3"

echo "=== 1. systemd unit ==="
sudo tee /etc/systemd/system/pithagoras-hermes-bridge.service >/dev/null <<EOF
[Unit]
Description=Pithagoras Hermes bridge (llama.cpp face -> Hermes Agent API .197:8642)
After=network-online.target
Wants=network-online.target

[Service]
User=hermes
Group=hermes
WorkingDirectory=$BRIDGE_DIR
ExecStart=$PYTHON3 $BRIDGE_DIR/bridge.py
Restart=on-failure
RestartSec=2
Environment=HERMES_API_KEY_FILE=$KEY_FILE
Environment=HERMES_API_URL=http://192.168.0.197:8642
Environment=BRIDGE_PORT=7865
Environment=BRIDGE_HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now pithagoras-hermes-bridge
sleep 1
sudo systemctl is-active pithagoras-hermes-bridge

echo "=== 2. pi settings.json (backup first) ==="
VOL=/var/lib/docker/volumes/pithagoras_portal-data/_data
[ -f $VOL/home/.pi/agent/settings.json ] || { echo "ERROR: $VOL/home/.pi/agent/settings.json not found"; exit 1; }
cp $VOL/home/.pi/agent/settings.json /opt/pithagoras/backup/settings.json.before-hermes-bridge-$(date +%Y%m%d)
python3 - $VOL/home/.pi/agent/settings.json <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["llamaSettings"] = {"servers": [
    {"id": "local",  "url": "http://127.0.0.1:8080", "apiKey": "none", "contextWindowSize": 32768},
    {"id": "hermes", "url": "http://127.0.0.1:7865", "apiKey": "none", "contextWindowSize": 32768},
]}
json.dump(d, open(p, "w"), indent=2)
print("settings.json updated (backup saved)")
PY

echo "=== 3. end-to-end verify (LAN path, through the bridge) ==="
K=$(cat $KEY_FILE)
B=http://127.0.0.1:7865
echo -n "health:   "; curl -s $B/health
echo; echo -n "props:    "; curl -s "$B/props" | head -c 120
echo; echo -n "v1/models:"; curl -s "$B/v1/models" | head -c 120
echo; echo -n "chat:     "; curl -s -X POST $B/chat/completions \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"model":"hermes","messages":[{"role":"user","content":"Reply with exactly: pong"}]}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); m=d.get('message') or (d['choices'][0]['message'] if d.get('choices') else None); print(m['content'] if m else 'ERROR', '| usage:', d.get('usage'))"
echo
echo "=== 4. portal sees both servers ==="
docker exec pithagoras sh -c 'grep -o "\"llamaSettings\"[^}]*}" /data/home/.pi/agent/settings.json | head -c 300 || true'
echo
echo "DONE. Next: docker restart pithagoras  (brief portal blip) -> model picker shows both models."
