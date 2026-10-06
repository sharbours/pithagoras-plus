#!/bin/bash
# Re-apply the Qwen3-TTS venv patch that makes the OFFICIAL backend honor
# TTS_DEVICE=cpu (skip the cuda:0 attempt entirely -> no OOM -> no ~2 GB GPU
# context leak when running the 1.7B-Base clone engine on CPU).
# The venv is not part of this repo; run this after any venv reinstall:
#   /opt/qwen3-tts/apply-cpu-device-patch.sh
# Idempotent: detects an already-patched file and exits 0.
set -e
F=/opt/qwen3-tts/venv/lib/python3.10/site-packages/api/backends/official_qwen3_tts.py
if grep -q 'TTS_DEVICE' "$F" 2>/dev/null; then
  echo "already patched: $F"
  exit 0
fi
cp -n "$F" "$F.bak-cpudev"
python3 - "$F" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = '            if torch.cuda.is_available():\n                self.device = "cuda:0"\n'
new = ('            import os as _os\n'
       '            if _os.environ.get("TTS_DEVICE", "").strip().lower() == "cpu":\n'
       '                self.device = "cpu"\n'
       '            elif torch.cuda.is_available():\n'
       '                self.device = "cuda:0"\n')
assert s.count(old) == 1, "anchor not found (venv changed?)"
open(p, "w").write(s.replace(old, new))
print("patched", p)
PYEOF
