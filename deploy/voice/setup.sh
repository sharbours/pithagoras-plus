#!/usr/bin/env bash
set -euo pipefail
trap 'echo "VOICE_SETUP_ERROR: setup or service failed (line $LINENO)" >&2' ERR
export DEBIAN_FRONTEND=noninteractive
cd /voice

# Cached artifacts from a previous run of this container (they live on the
# pithagoras_voice-models volume and survive container recreation).
have_tools() {
  command -v git >/dev/null 2>&1 && command -v cmake >/dev/null 2>&1 && command -v ninja >/dev/null 2>&1 \
    && command -v curl >/dev/null 2>&1 && command -v aria2c >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1
}
have_builds() {
  [ -x audio/build/portal/bin/audiocpp_gguf ] && [ -x audio/build/portal/bin/audiocpp_server ] && [ -x whisper/build/bin/whisper-server ]
}
have_models() {
  [ -s models/ggml-base.bin ] && [ -s models/breeze-q8_0.gguf ]
}

if have_builds && have_models; then
  # Self-heal path: everything is already built and downloaded on the volume,
  # so no apt, no build, no network. This is also what makes the container
  # immune to apt/keyring breakage: setup never has to touch apt at all.
  echo 'VOICE_STAGE: Reusing cached build and models (skipping apt/build/download)'
else
  if ! have_tools; then
    echo 'VOICE_STAGE: Installing build tools'
    dpkg --configure -a
    # The Ubuntu keyring baked into this image predates 2020; when the upstream
    # key rotates, EVERY repo fails GPG verification and a strict apt-get update
    # aborts this script (set -e), leaving STT down (observed 2026-09-26: exit 100
    # at the apt-get update step). Refresh the current ubuntu-keyring .deb first
    # (fetched straight from the archive pool, no GPG verification involved),
    # best-effort re-import the NVIDIA CUDA key, and update the indexes
    # tolerantly so a key problem can never kill this script again.
    if command -v curl >/dev/null 2>&1; then
      for base in "http://archive.ubuntu.com/ubuntu/pool/main/u/ubuntu-keyring/" \
                  "http://archive.ubuntu.com/ubuntu/pool/updates/main/u/ubuntu-keyring/"; do
        url=$(curl -fsSL "$base" 2>/dev/null | grep -oE 'ubuntu-keyring_[0-9][^"]*_all\.deb' | sort -V | tail -1 || true)
        if [ -n "$url" ] && curl -fsSL -o /tmp/ubuntu-keyring.deb "$base$url"; then
          echo "VOICE_STAGE: Refreshing Ubuntu keyring from $url"
          dpkg -i /tmp/ubuntu-keyring.deb >/dev/null 2>&1 || true
          rm -f /tmp/ubuntu-keyring.deb
          break
        fi
      done
      for cuda_list in /etc/apt/sources.list.d/cuda.list /etc/apt/sources.list.d/cuda*.list; do
        [ -f "$cuda_list" ] || continue
        keyfile=$(grep -hoE '(signed-by|keyring)=[^ ]+' "$cuda_list" 2>/dev/null | head -1 | cut -d= -f2)
        if [ -n "$keyfile" ] && [ ! -s "$keyfile" ]; then
          mkdir -p "$(dirname "$keyfile")"
          curl -fsSL -o "$keyfile" "https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/key.asc" 2>/dev/null \
            || echo 'WARNING: could not refresh the NVIDIA CUDA repo key'
        fi
        break
      done
    fi
    apt-get update || echo 'WARNING: apt-get update reported errors (keyring/GPG); continuing anyway'
    apt-get install -y --no-install-recommends git cmake ninja-build build-essential curl ca-certificates python3 libssl-dev aria2
    touch /usr/local/share/pithagoras-voice-deps
  fi
  checkout() {
    local directory="$1" repository="$2" revision="$3"
    if [ ! -d "$directory/.git" ]; then git clone "$repository" "$directory"; fi
    git -C "$directory" checkout "$revision"
    git -C "$directory" submodule update --init --recursive
  }
  echo 'VOICE_STAGE: Preparing pinned audio runtime'
  checkout audio https://github.com/0xShug0/audio.cpp.git efb04233dab73aeee4b2912042a90e7b36329061
  if [ ! -x audio/build/portal/bin/audiocpp_gguf ] || [ ! -x audio/build/portal/bin/audiocpp_server ] || ! grep -q 'AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER:BOOL=ON' audio/build/portal/CMakeCache.txt; then
    echo 'VOICE_STAGE: Building CUDA speech runtime and quantizer'
    architecture=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '. ')
    (cd audio && bash scripts/build_linux.sh --native-model-manager --system-openssl --cuda on --cuda-arch "$architecture" --build-dir /voice/audio/build/portal --build-type Release --model-set custom --models breeze_tts --target audiocpp_server --target audiocpp_gguf --jobs 4) 2>&1 | tr '\r' '\n'
  fi
  echo 'VOICE_STAGE: Preparing CPU speech recognition'
  checkout whisper https://github.com/ggml-org/whisper.cpp.git a2b36eb677918d4f9ab1db7b8a7ff968563ed163
  if [ ! -x whisper/build/bin/whisper-server ]; then
    cmake -S whisper -B whisper/build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DWHISPER_BUILD_SERVER=ON
    cmake --build whisper/build --target whisper-server -j 4
  fi
  mkdir -p models
  download() {
    local url="$1" destination="$2"
    if [ ! -s "$destination" ]; then
      aria2c --continue=true --max-connection-per-server=4 --split=4 --min-split-size=16M --file-allocation=none --auto-file-renaming=false --max-tries=5 --retry-wait=5 --summary-interval=10 --console-log-level=warn --checksum=sha-256=a00c9f678b4c5ae03d1dcd228f636b329352cda200823faef4e01d3bd97c0a89 --dir="$(dirname "$destination")" --out="$(basename "$destination").part" "$url" 2>&1 | tr '\r' '\n'
      mv "$destination.part" "$destination"
    fi
  }
  if [ ! -s models/ggml-base.bin ]; then
    echo 'VOICE_STAGE: Downloading multilingual Whisper base'
    bash whisper/models/download-ggml-model.sh base /voice/models 2>&1 | tr '\r' '\n'
  fi
  if [ ! -s models/breeze-q8_0.gguf ]; then
    echo 'VOICE_STAGE: Downloading full-precision Breeze-TTS-2'
    download "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/056144d2744697c9439bd32647279674dba0c964/Breeze-TTS-2-GGUF/breeze-tts-2-bf16.gguf" models/breeze-bf16.gguf
    echo 'VOICE_STAGE: Quantizing Breeze to Q8_0 on CPU'
    audio/build/portal/bin/audiocpp_gguf --input models/breeze-bf16.gguf --output models/breeze-q8_0.partial.gguf --type q8_0 --overwrite
    audio/build/portal/bin/audiocpp_gguf --inspect models/breeze-q8_0.partial.gguf
    mv models/breeze-q8_0.partial.gguf models/breeze-q8_0.gguf
    rm models/breeze-bf16.gguf
  fi
fi

cat > /voice/server.json <<'JSON'
{"host":"127.0.0.1","port":7862,"backend":"cuda","device":0,"threads":4,"lazy_load":true,"idle_unload_ms":90000,"ui_management":true,"max_loaded_models":1,"models":[{"id":"breeze","family":"breeze_tts","path":"/voice/models/breeze-q8_0.gguf","task":"tts","mode":"streaming","session_options":{"breeze_tts.reference_cache_slots":1}}]}
JSON
echo 'VOICE_STAGE: Starting speech services'
whisper/build/bin/whisper-server --host 127.0.0.1 --port 8188 --model /voice/models/ggml-base.bin --language auto --threads 4 &
whisper_pid=$!
audio/build/portal/bin/audiocpp_server --config /voice/server.json &
speech_pid=$!
trap 'kill "$whisper_pid" "$speech_pid" 2>/dev/null || true; wait; exit 0' TERM INT
set +e
wait -n "$whisper_pid" "$speech_pid"
code=$?
kill "$whisper_pid" "$speech_pid" 2>/dev/null
wait
exit "$code"
