#!/bin/bash
# compile.sh — Build VLC as a WebAssembly module using Emscripten
#
# This script:
#   1. Activates the Emscripten SDK
#   2. Clones the VLC source (if not already present)
#   3. Resets to a known-good commit
#   4. Applies VLC.js-specific patches
#   5. Runs the VLC WASM build system (contribs + VLC core + modules)
#   6. Generates the symbol export list
#   7. Calls create_main.sh for the final emcc linking step
#
# Adapted from: https://code.videolan.org/jbk/vlc.js/-/blob/incoming/compile.sh
#
# Environment variables:
#   SLOW_MODE  — Build mode for VLC's wasm-emscripten build.sh (default: 1)
#                1 = full rebuild from source (required for first build)
#   EMSDK      — Path to Emscripten SDK (default: /opt/emsdk in Docker)
#   VLC_COMMIT — Override the VLC commit hash to build against

set -e

# ---- Configuration ----

# Emscripten SDK version — must match what is installed in the Docker image.
# To upgrade: change EMSDK_VERSION in the Dockerfile and rebuild the image.
# The compile.sh does not install emsdk itself; it expects it pre-installed.
# Original upstream used: 3.1.18
# Current upstream Docker image uses: 4.0.1
EMSDK_VERSION="4.0.1"

# VLC commit hash known to work with the patches in vlc_patches/aug/.
# Original upstream: 06e361b127e4609e429909756212ed5e30e7d032
# To upgrade: set a newer hash here (or via VLC_COMMIT env var), then verify
# that all patches in vlc_patches/aug/ apply cleanly.
TESTED_HASH="${VLC_COMMIT:-06e361b127e4609e429909756212ed5e30e7d032}"

SLOW_MODE="${SLOW_MODE:-1}"
WORK_DIR="${PWD}"
EMSDK_DIR="${EMSDK:-/opt/emsdk}"

# ---- Helper functions ----

diagnostic() {
    echo "$@" 1>&2
}

checkfail() {
    if [ ! $? -eq 0 ]; then
        diagnostic "$1"
        exit 1
    fi
}

# ---- Step 1: Activate Emscripten SDK ----

if [ ! -d "${EMSDK_DIR}" ]; then
    diagnostic "ERROR: Emscripten SDK not found at ${EMSDK_DIR}"
    diagnostic "When running outside Docker, install emsdk first:"
    diagnostic "  git clone https://github.com/emscripten-core/emsdk.git ${EMSDK_DIR}"
    diagnostic "  cd ${EMSDK_DIR} && ./emsdk install ${EMSDK_VERSION} && ./emsdk activate ${EMSDK_VERSION}"
    exit 1
fi

diagnostic "Activating Emscripten SDK at ${EMSDK_DIR}"
# shellcheck disable=SC1091
. "${EMSDK_DIR}/emsdk_env.sh"

# Verify emcc is available
if ! command -v emcc &> /dev/null; then
    diagnostic "ERROR: emcc not found after activating emsdk. Check your installation."
    exit 1
fi
diagnostic "Using emcc version: $(emcc --version | head -1)"

# ---- Step 2: Clone VLC source ----

cd "${WORK_DIR}"

if [ ! -d vlc ]; then
    diagnostic "VLC source not found, cloning..."
    git clone https://code.videolan.org/videolan/vlc.git vlc
    checkfail "VLC source: git clone failed"

    cd vlc
    diagnostic "VLC source: resetting to TESTED_HASH (${TESTED_HASH})"
    git reset --hard "${TESTED_HASH}"
    checkfail "VLC source: TESTED_HASH ${TESTED_HASH} not found"

    # ---- Step 3: Apply patches ----
    # These patches modify VLC to build correctly under Emscripten and add
    # the WebAssembly-specific audio/video output modules.
    #
    # Patch series in vlc_patches/aug/:
    #   0001 — Fix configure GL function tests for Emscripten
    #   0002 — Disable libvlc_json and ytbdl modules (not needed for WASM)
    #   0003-0006 — Add wasm-emscripten support to contribs (ass, gcrypt, gmp, gnutls)
    #   0007-0013 — Emscripten audio worklet output module
    #   0014-0016 — Emscripten WebGL video output module
    #   0017 — Allow C OpenGL modules in vout
    #   0018 — Start vout from vout thread (Emscripten threading fix)
    #   0019 — Forcefully disable accept4 (not available in Emscripten)
    #   0020 — Convert emscripten vout to C
    if [ -d ../vlc_patches/aug ] && [ "$(ls -A ../vlc_patches/aug)" ]; then
        diagnostic "Applying VLC patches from vlc_patches/aug/..."
        git am -3 ../vlc_patches/aug/*
        checkfail "Failed to apply VLC patches"
    else
        diagnostic "WARNING: No patches found in vlc_patches/aug/. Build may fail."
    fi

    cd "${WORK_DIR}"
else
    diagnostic "VLC source directory already exists, skipping clone"
fi

# ---- Step 4: Build VLC for WebAssembly ----

diagnostic "Building VLC for WebAssembly (SLOW_MODE=${SLOW_MODE})..."
cd ./vlc/extras/package/wasm-emscripten/
./build.sh --mode="${SLOW_MODE}"
cd "${WORK_DIR}"

# ---- Step 5: Generate symbol export list ----
# The export list tells emcc which C functions to expose to JavaScript.
# _main is always needed. The rest come from libvlc's public API symbols.

diagnostic "Generating symbol export list..."
echo "_main" > libvlc_wasm.sym
sed -e 's/^/_/' ./vlc/lib/libvlc.sym >> libvlc_wasm.sym

# ---- Step 6: Final link step ----

diagnostic "Linking final WebAssembly executable..."
cd "${WORK_DIR}"
./create_main.sh

diagnostic ""
diagnostic "Build complete! Output files:"
diagnostic "  experimental.js"
diagnostic "  experimental.wasm"
diagnostic "  experimental.worker.js"
