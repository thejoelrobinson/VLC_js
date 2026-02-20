#!/bin/bash
# compile.sh — Build VLC as a WebAssembly module using Emscripten
#
# This script uses VLC's BUILT-IN wasm-emscripten build infrastructure
# (extras/package/wasm-emscripten/build.sh) which is part of VLC master.
#
# The old vlc.js approach (2022) required 20+ external patches. Modern VLC
# master has native WASM support including audio worklet output, WebGL video
# output, and Emscripten threading — no core patches needed.
#
# Flow:
#   1. Activate Emscripten SDK
#   2. Clone VLC master at TESTED_HASH
#   3. (Optional) Apply vlc.js wrapper patches if present
#   4. Run VLC's own wasm-emscripten build system
#   5. Generate symbol export list
#   6. Call create_main.sh for final emcc linking
#
# Adapted from: https://code.videolan.org/jbk/vlc.js/-/blob/incoming/compile.sh
# VLC WASM build docs: extras/package/wasm-emscripten/ in VLC source
#
# Environment variables:
#   SLOW_MODE  — Build mode (default: 1 = full from source, required first time)
#   EMSDK      — Path to Emscripten SDK (default: /opt/emsdk)
#   VLC_COMMIT — Override the VLC commit hash

set -e

# ---- Configuration ----

# VLC master commit hash — TESTED_HASH pattern from upstream vlc.js.
# This hash is known to build successfully with the current Emscripten version.
#
# 65e744b0 = 2026-01-29: latest wasm-emscripten build.sh change
#            (removed schroedinger, uses avcodec for Dirac)
#
# Previous hashes:
#   06e361b1 = 2022 (vlc.js incoming branch, Emscripten 3.1.18)
#   7bad2a86 = 2020 (vlc.js master branch, Emscripten tot-upstream)
#
# To upgrade: pick a newer commit from VLC master, update this hash.
# Check recent wasm-emscripten changes at:
#   https://code.videolan.org/videolan/vlc/-/commits/master/extras/package/wasm-emscripten
TESTED_HASH="${VLC_COMMIT:-65e744b0}"

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
    diagnostic "  cd ${EMSDK_DIR} && ./emsdk install 4.0.1 && ./emsdk activate 4.0.1"
    exit 1
fi

diagnostic "Activating Emscripten SDK at ${EMSDK_DIR}"
# shellcheck disable=SC1091
. "${EMSDK_DIR}/emsdk_env.sh"

if ! command -v emcc &> /dev/null; then
    diagnostic "ERROR: emcc not found after activating emsdk."
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

    # ---- Step 3: Apply vlc.js wrapper patches (if any) ----
    # VLC master now includes core WASM support (audio worklet, WebGL vout,
    # Emscripten threading). These patches are only needed for vlc.js-specific
    # wrapper integration that hasn't been upstreamed yet.
    #
    # If building against a recent VLC master commit, many or all patches
    # from vlc_patches/aug/ may already be merged. The build will warn if
    # patches fail to apply — this is expected for already-merged patches.
    if [ -d ../vlc_patches/aug ] && [ "$(ls -A ../vlc_patches/aug 2>/dev/null)" ]; then
        diagnostic "Attempting to apply vlc.js patches from vlc_patches/aug/..."
        for patch in ../vlc_patches/aug/*; do
            if git am -3 "$patch" 2>/dev/null; then
                diagnostic "  Applied: $(basename "$patch")"
            else
                diagnostic "  Skipped (already merged or conflict): $(basename "$patch")"
                git am --abort 2>/dev/null || true
            fi
        done
    else
        diagnostic "No vlc.js patches found — using VLC master as-is (expected for recent commits)"
    fi

    cd "${WORK_DIR}"
else
    diagnostic "VLC source directory already exists, skipping clone"
fi

# ---- Step 4: Build VLC for WebAssembly ----
# Uses VLC's built-in wasm-emscripten build system.
# This compiles all contribs (FFmpeg, etc.) and VLC core + modules.
#
# VLC's build.sh enables:
#   --enable-avcodec --enable-avformat --enable-swscale --enable-postproc
#   --enable-gles2 --enable-vpx
# And disables everything not needed for browser playback.

diagnostic "Building VLC for WebAssembly (SLOW_MODE=${SLOW_MODE})..."
diagnostic "Using VLC's built-in extras/package/wasm-emscripten/build.sh"
cd ./vlc/extras/package/wasm-emscripten/
./build.sh --mode="${SLOW_MODE}"
cd "${WORK_DIR}"

# ---- Step 5: Generate symbol export list ----

diagnostic "Generating symbol export list..."
echo "_main" > libvlc_wasm.sym
# _malloc and _free are required by the JS wrapper (main.js, lib/libvlc.js)
# Emscripten 4.0.1+ does not export them by default
echo "_malloc" >> libvlc_wasm.sym
echo "_free" >> libvlc_wasm.sym
sed -e 's/^/_/' ./vlc/lib/libvlc.sym >> libvlc_wasm.sym

# ---- Step 6: Final link step ----

diagnostic "Linking final WebAssembly executable..."
cd "${WORK_DIR}"
./create_main.sh

diagnostic ""
diagnostic "Build complete! Output files:"
ls -lh experimental.js experimental.wasm 2>/dev/null
ls -lh experimental.worker.js 2>/dev/null || true
