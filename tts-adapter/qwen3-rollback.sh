#!/bin/bash
# Rollback for the Qwen3-TTS PoC — thin wrapper around the canonical
# restore script (kept for README / muscle-memory references).
# The real work: /opt/qwen3-tts/qwen3-restore-code2.sh (idempotent; also runs
# automatically at boot via the enabled qwen3-reboot-restore service).
exec bash /opt/qwen3-tts/qwen3-restore-code2.sh
